import { createSign } from "node:crypto";
import { Queryable } from "./db.js";

export type DriveConfiguration = {
  serviceAccountEmail?: string;
  serviceAccountKey?: string;
  folderId?: string;
};

type ResolvedDriveConfiguration = Required<DriveConfiguration>;

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DocumentLayer = "principios" | "estructura" | "recursos";
const LAYER_NAMES: DocumentLayer[] = ["principios", "estructura", "recursos"];

export function driveConfigured(config: DriveConfiguration): config is ResolvedDriveConfiguration {
  return Boolean(config.serviceAccountEmail && config.serviceAccountKey && config.folderId);
}

// One of the 3 EstrategiaHCS subfolders, matched by name — anything else
// directly under DRIVE_FOLDER_ID (a stray file, an unrelated subfolder) is
// ignored rather than guessed at.
export function resolveLayerFolder(folderName: string): DocumentLayer | null {
  const normalized = folderName.trim().toLowerCase();
  return LAYER_NAMES.find((layer) => layer === normalized) ?? null;
}

// nuevo: never seen this drive_file_id before. en_revision: content changed
// since last sync. undefined: unchanged — caller must leave the existing
// status alone (a reviewed document must not be silently reset).
export function decideSyncStatus(previousHash: string | undefined, currentHash: string): "nuevo" | "en_revision" | undefined {
  if (previousHash === undefined) return "nuevo";
  return previousHash === currentHash ? undefined : "en_revision";
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Hand-rolled service-account JWT-bearer flow (RFC 7523) for a single
// read-only scope — simpler than pulling in the full googleapis SDK for
// what is otherwise one token exchange before a handful of REST calls.
export async function getAccessToken(config: ResolvedDriveConfiguration): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: config.serviceAccountEmail,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  // Render (and most env-var stores) can't hold real newlines, so the key is
  // stored with literal "\n" escapes and unescaped here.
  const privateKey = config.serviceAccountKey.replace(/\\n/g, "\n");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  const assertion = `${signingInput}.${base64url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DRIVE_AUTH_ERROR_${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  md5Checksum?: string;
};

async function listChildren(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(DRIVE_FILES_API);
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, md5Checksum)");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`DRIVE_FETCH_ERROR_${response.status}`);
    const body = (await response.json()) as { files: DriveFile[]; nextPageToken?: string };
    files.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

export async function downloadDriveFile(accessToken: string, fileId: string): Promise<Buffer> {
  const response = await fetch(`${DRIVE_FILES_API}/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`DRIVE_DOWNLOAD_ERROR_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export type DriveSyncSummary = {
  layersScanned: number;
  filesSeen: number;
  created: number;
  markedForReview: number;
  unchanged: number;
};

export async function syncDriveDocuments(db: Queryable, config: DriveConfiguration): Promise<DriveSyncSummary> {
  if (!driveConfigured(config)) throw new Error("DRIVE_NOT_CONFIGURED");
  const accessToken = await getAccessToken(config);

  const topLevel = await listChildren(accessToken, config.folderId);
  const layerFolders = topLevel
    .filter((entry) => entry.mimeType === FOLDER_MIME)
    .map((entry) => ({ folder: entry, layer: resolveLayerFolder(entry.name) }))
    .filter((entry): entry is { folder: DriveFile; layer: DocumentLayer } => entry.layer !== null);

  const summary: DriveSyncSummary = { layersScanned: layerFolders.length, filesSeen: 0, created: 0, markedForReview: 0, unchanged: 0 };

  for (const { folder, layer } of layerFolders) {
    const files = (await listChildren(accessToken, folder.id)).filter((file) => file.mimeType !== FOLDER_MIME);
    summary.filesSeen += files.length;

    for (const file of files) {
      // Native Google Docs/Sheets have no md5Checksum (they aren't a fixed
      // byte blob) — modifiedTime is the next best change signal for those.
      const contentHash = file.md5Checksum ?? `modified:${file.modifiedTime}`;
      const driveUrl = file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`;

      const existing = await db.query(`SELECT content_hash FROM source_documents WHERE drive_file_id = $1`, [file.id]);
      const previousHash = (existing.rows[0] as { content_hash: string } | undefined)?.content_hash;
      const status = decideSyncStatus(previousHash, contentHash);

      await db.query(
        `INSERT INTO source_documents (drive_file_id, title, layer, content_hash, mime_type, drive_url, status)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'nuevo'))
         ON CONFLICT (drive_file_id) DO UPDATE
           SET title = EXCLUDED.title,
               mime_type = EXCLUDED.mime_type,
               drive_url = EXCLUDED.drive_url,
               content_hash = EXCLUDED.content_hash,
               status = COALESCE($7, source_documents.status),
               ingested_at = CASE WHEN $7 IS NOT NULL THEN now() ELSE source_documents.ingested_at END,
               -- A changed hash means the old summary (JME-36) describes
               -- stale content; clear it so the extraction pass regenerates it.
               summary = CASE WHEN $7 IS NOT NULL THEN NULL ELSE source_documents.summary END`,
        [file.id, file.name, layer, contentHash, file.mimeType, driveUrl, status ?? null],
      );

      if (status === "nuevo") summary.created += 1;
      else if (status === "en_revision") summary.markedForReview += 1;
      else summary.unchanged += 1;
    }
  }

  return summary;
}
