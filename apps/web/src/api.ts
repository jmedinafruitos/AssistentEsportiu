import { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

const configuredBaseUrl = (import.meta as ImportMeta & { env: { VITE_API_URL?: string } }).env.VITE_API_URL;
const API_URL = (configuredBaseUrl ?? "").replace(/\/$/, "");

export type Team = { id: string; name: string; season: string; category?: string };
export type CurrentUser = {
  id: string; name: string; email: string;
  role: "club_admin" | "coordinator" | "coach";
  sport_role: string | null; global_access: boolean; teams: Team[];
};
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
// Training's shape matches docs/ficha-entreno-schema.md (JME-42); match is
// unchanged from JME-10. Activation fields are per-phase free text, not
// booleans — see that doc for why.
export type TrainingActivation = {
  prevencion?: string; activacionPorteros?: string; activacionJugadores?: string; integrado?: string; participativo?: string;
};
export type TrainingBlockInput = { description: string; diagramAssetUrl?: string; exerciseId?: string };
export type TrainingBlock = { orderIndex: number; description: string; diagramAssetUrl: string | null; exerciseId: string | null };
export type RecordInput =
  | { type: "match"; happenedAt: string; summary: string; outcome?: string; nextObjectives: string[] }
  | { type: "training"; happenedAt: string; sessionNumber?: number; coach?: string; notes?: string; activation?: TrainingActivation; blocks: TrainingBlockInput[] };
export type TeamRecord = {
  id: string; record_type: "training" | "match"; happened_at: string;
  content:
    | { summary: string; outcome?: string | null; nextObjectives?: string[] }
    | { sessionNumber: number | null; coach: string | null; notes: string | null; activation: TrainingActivation; blocks: TrainingBlock[] };
  created_at: string; created_by_name?: string;
};
// JME-44: AI-assisted training-session preparation. Step order mirrors
// apps/api/src/training-preparation.ts's deriveSteps exactly — 5 fixed
// activation phases, then one entry per draft block, then "review".
export const ACTIVATION_PHASES = ["prevencion", "activacionPorteros", "activacionJugadores", "integrado", "participativo"] as const;
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];
export const ACTIVATION_LABELS: Record<ActivationPhase, string> = {
  prevencion: "Prevenció", activacionPorteros: "Activació porters", activacionJugadores: "Activació jugadors",
  integrado: "Integrat", participativo: "Participatiu",
};
export type PreparationStep = { kind: "activation"; phase: ActivationPhase } | { kind: "block"; index: number } | { kind: "review" };
export function derivePreparationSteps(content: PreparationContent): PreparationStep[] {
  return [
    ...ACTIVATION_PHASES.map((phase): PreparationStep => ({ kind: "activation", phase })),
    ...content.blocks.map((_, index): PreparationStep => ({ kind: "block", index })),
    { kind: "review" },
  ];
}
export type PreparationBlock = { orderIndex: number; description: string; diagramAssetUrl: string | null; exerciseId: string | null };
export type PreparationContent = {
  sessionNumber: number | null; coach: string | null; notes: string | null;
  activation: Record<ActivationPhase, string>;
  blocks: PreparationBlock[];
};
export type TrainingPreparation = { id: string; status: "drafting" | "ready" | "sent"; draft_content: PreparationContent; current_step: number };
export type RefineAction =
  | { action: "approve" }
  | { action: "back" }
  | { action: "feedback"; instruction: string }
  | { action: "swap_exercise"; exerciseId: string | null }
  | { action: "edit"; value: string };

export type Exercise = {
  id: string; name: string; type: "juego" | "circuito" | "ejercicio" | "tactica"; description: string | null;
  variants: string[]; tags: string[]; source_document_id: string | null; page_ref: string | null; created_at: string;
};
export type CoordinatorOverview = {
  teams: Array<Team & { staff_count: number; record_count: number; last_activity_at: string | null }>;
  pendingProposals: Array<{
    id: string; reason: string; proposed_at: string; proposed_by_name: string;
    source_document_id: string | null; source_document_title: string | null;
    source_document_layer: "principios" | "estructura" | "recursos" | null;
    source_document_drive_url: string | null; source_document_summary: string | null;
  }>;
};
export type TeamPlan = { id: string; season: string; version: number; content: { seasonObjectives: string[]; nextTrainingObjectives: string[]; notes: string } };
export type AssistantResult = { id: string; user_message: string; assistant_message: string; created_at: string; requested_by: string };
export type TeamEvent = {
  id: string; event_type: "training" | "match" | "meeting"; title: string;
  starts_at: string; ends_at: string | null; location: string | null; notes: string | null;
  source: "manual" | "recurring" | "fecapa"; canceled: boolean; created_at: string;
  training_series_id?: string | null; overridden?: boolean;
};
export type TrainingSeries = {
  id: string; team_id: string; title: string; weekdays: number[]; time: string;
  duration_minutes: number | null; starts_on: string; ends_on: string; active?: boolean;
};
export type EventAction = { id: string; label: string; content: Record<string, unknown>; sort_order: number; completed_at: string | null };
export type EventTypeActionTemplate = {
  id: string; scope: "club" | "category" | "team"; category_id: string | null; team_id: string | null;
  event_type: "training" | "match" | "meeting"; label: string; content: Record<string, unknown>;
  sort_order: number; active: boolean; category?: string | null; team?: string | null;
};
export type FecapaSyncSummary = { leagues: number; matchesSeen: number; eventsCreated: number; eventsUpdated: number };

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  // Only set content-type when there's actually a body — Fastify's default
  // JSON parser rejects a request with this header but no body outright
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which silently 400'd every no-body POST
  // (syncFecapa, and now startPreparation/finalizePreparation/sendPreparation).
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) => request<{ token: string }>("/v1/session", { method: "POST", body: JSON.stringify({ email, password }) }),
  webauthnRegisterOptions: (token: string) =>
    request<PublicKeyCredentialCreationOptionsJSON>("/v1/webauthn/register/options", { method: "POST" }, token),
  webauthnRegisterVerify: (token: string, response: RegistrationResponseJSON, deviceLabel?: string) =>
    request<{ registered: true }>("/v1/webauthn/register/verify", { method: "POST", body: JSON.stringify({ response, deviceLabel }) }, token),
  webauthnLoginOptions: (email: string) =>
    request<PublicKeyCredentialRequestOptionsJSON>("/v1/webauthn/login/options", { method: "POST", body: JSON.stringify({ email }) }),
  webauthnLoginVerify: (email: string, response: AuthenticationResponseJSON) =>
    request<{ token: string }>("/v1/webauthn/login/verify", { method: "POST", body: JSON.stringify({ email, response }) }),
  me: (token: string) => request<CurrentUser>("/v1/me", {}, token),
  teams: (token: string) => request<{ teams: Team[] }>("/v1/teams", {}, token),
  chat: (token: string, teamId: string, message: string, history: ChatMessage[]) =>
    request<{ id: string; content: string; createdAt: string }>("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ teamId, message, history: history.slice(-10).map(({ role, content }) => ({ role, content })) }),
    }, token),
  records: (token: string, teamId: string) => request<{ records: TeamRecord[] }>(`/v1/teams/${teamId}/records`, {}, token),
  createRecord: (token: string, teamId: string, record: RecordInput) =>
    request<TeamRecord>(`/v1/teams/${teamId}/records`, { method: "POST", body: JSON.stringify(record) }, token),
  exercises: (token: string) => request<{ exercises: Exercise[] }>("/v1/exercises", {}, token),
  getPreparation: (token: string, teamId: string, eventId: string) =>
    request<TrainingPreparation>(`/v1/teams/${teamId}/events/${eventId}/preparation`, {}, token),
  startPreparation: (token: string, teamId: string, eventId: string) =>
    request<TrainingPreparation>(`/v1/teams/${teamId}/events/${eventId}/preparation`, { method: "POST" }, token),
  updatePreparationHeader: (token: string, teamId: string, eventId: string, header: { sessionNumber?: number | null; coach?: string | null; notes?: string | null }) =>
    request<TrainingPreparation>(`/v1/teams/${teamId}/events/${eventId}/preparation/header`, { method: "PATCH", body: JSON.stringify(header) }, token),
  refinePreparationStep: (token: string, teamId: string, eventId: string, step: number, action: RefineAction) =>
    request<TrainingPreparation>(`/v1/teams/${teamId}/events/${eventId}/preparation/steps/${step}`, { method: "POST", body: JSON.stringify(action) }, token),
  finalizePreparation: (token: string, teamId: string, eventId: string) =>
    request<TrainingPreparation>(`/v1/teams/${teamId}/events/${eventId}/preparation/finalize`, { method: "POST" }, token),
  previewPreparationPdf: async (token: string, teamId: string, eventId: string): Promise<Blob> => {
    const response = await fetch(`${API_URL}/v1/teams/${teamId}/events/${eventId}/preparation/pdf`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  },
  sendPreparation: (token: string, teamId: string, eventId: string) =>
    request<{ id: string; status: string; sent_at: string; recipients: string[] }>(`/v1/teams/${teamId}/events/${eventId}/preparation/send`, { method: "POST" }, token),
  coordinatorOverview: (token: string) => request<CoordinatorOverview>("/v1/coordinator/overview", {}, token),
  plan: (token: string, teamId: string) => request<{ plan: TeamPlan | null }>(`/v1/teams/${teamId}/plan`, {}, token),
  savePlan: (token: string, teamId: string, plan: { seasonObjectives: string[]; nextTrainingObjectives: string[]; notes: string; version?: number }) => request<TeamPlan>(`/v1/teams/${teamId}/plan`, { method: "PUT", body: JSON.stringify(plan) }, token),
  assistantResults: (token: string, teamId: string) => request<{ results: AssistantResult[] }>(`/v1/teams/${teamId}/assistant-results`, {}, token),
  events: (token: string, teamId: string, week: { from: string; to: string }) =>
    request<{ events: TeamEvent[] }>(`/v1/teams/${teamId}/events?${new URLSearchParams(week)}`, {}, token),
  createEvent: (token: string, teamId: string, event: { eventType: "training" | "match" | "meeting"; title: string; startsAt: string; endsAt?: string; location?: string; notes?: string }) =>
    request<{ event: TeamEvent; actions: EventAction[] }>(`/v1/teams/${teamId}/events`, { method: "POST", body: JSON.stringify(event) }, token),
  generateTrainings: (token: string, teamId: string, plan: { title?: string; weekdays: number[]; time: string; durationMinutes?: number; from: string; to: string }) =>
    request<{ created: number; events: TeamEvent[] }>(`/v1/teams/${teamId}/events/generate-trainings`, { method: "POST", body: JSON.stringify(plan) }, token),
  eventDetail: (token: string, teamId: string, eventId: string) =>
    request<{ event: TeamEvent; actions: EventAction[] }>(`/v1/teams/${teamId}/events/${eventId}`, {}, token),
  updateEvent: (token: string, teamId: string, eventId: string, patch: { title?: string; startsAt?: string; endsAt?: string | null; location?: string | null; notes?: string | null; canceled?: boolean }) =>
    request<TeamEvent>(`/v1/teams/${teamId}/events/${eventId}`, { method: "PATCH", body: JSON.stringify(patch) }, token),
  addEventAction: (token: string, teamId: string, eventId: string, action: { label: string; content?: Record<string, unknown> }) =>
    request<EventAction>(`/v1/teams/${teamId}/events/${eventId}/actions`, { method: "POST", body: JSON.stringify(action) }, token),
  updateEventAction: (token: string, teamId: string, eventId: string, actionId: string, patch: { label?: string; completed?: boolean }) =>
    request<EventAction>(`/v1/teams/${teamId}/events/${eventId}/actions/${actionId}`, { method: "PATCH", body: JSON.stringify(patch) }, token),
  removeEventAction: (token: string, teamId: string, eventId: string, actionId: string) =>
    request<Record<string, never>>(`/v1/teams/${teamId}/events/${eventId}/actions/${actionId}`, { method: "DELETE" }, token),
  eventTypeActions: (token: string) => request<{ actions: EventTypeActionTemplate[] }>("/v1/event-type-actions", {}, token),
  createEventTypeAction: (token: string, template: { scope: "club" | "category" | "team"; categoryId?: string; teamId?: string; eventType: "training" | "match" | "meeting"; label: string; content?: Record<string, unknown>; sortOrder?: number }) =>
    request<EventTypeActionTemplate>("/v1/event-type-actions", { method: "POST", body: JSON.stringify(template) }, token),
  updateEventTypeAction: (token: string, actionId: string, patch: { label?: string; content?: Record<string, unknown>; sortOrder?: number; active?: boolean }) =>
    request<EventTypeActionTemplate>(`/v1/event-type-actions/${actionId}`, { method: "PATCH", body: JSON.stringify(patch) }, token),
  syncFecapa: (token: string) => request<FecapaSyncSummary>("/v1/fecapa/sync", { method: "POST" }, token),
  trainingSeries: (token: string, teamId: string, seriesId: string) =>
    request<TrainingSeries>(`/v1/teams/${teamId}/training-series/${seriesId}`, {}, token),
  updateTrainingSeries: (token: string, teamId: string, seriesId: string, patch: {
    scope: "following" | "all"; fromEventId?: string; title?: string; weekdays?: number[];
    time?: string; durationMinutes?: number | null; endsOn?: string;
  }) =>
    request<{ series: TrainingSeries; created: number; events: TeamEvent[] }>(`/v1/teams/${teamId}/training-series/${seriesId}`, { method: "PATCH", body: JSON.stringify(patch) }, token),
};
