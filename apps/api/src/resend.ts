// Thin wrapper over Resend's REST API — plain fetch, no SDK, matching this
// codebase's style for every other external integration (ai.ts, drive.ts,
// fecapa.ts). Only what JME-44 needs: send one email with an optional
// attachment.

export type EmailConfiguration = {
  apiKey?: string;
  fromEmail?: string;
};
type ResolvedEmailConfiguration = Required<EmailConfiguration>;

const RESEND_API = "https://api.resend.com/emails";

export function emailConfigured(config: EmailConfiguration): config is ResolvedEmailConfiguration {
  return Boolean(config.apiKey && config.fromEmail);
}

export type EmailAttachment = { filename: string; content: Buffer; contentType: string };

export async function sendEmail(
  config: EmailConfiguration,
  message: { to: string[]; subject: string; html: string; attachments?: EmailAttachment[] },
): Promise<void> {
  if (!emailConfigured(config)) throw new Error("EMAIL_NOT_CONFIGURED");
  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: config.fromEmail,
      to: message.to,
      subject: message.subject,
      html: message.html,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content.toString("base64"),
      })),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RESEND_API_ERROR_${response.status}`);
}
