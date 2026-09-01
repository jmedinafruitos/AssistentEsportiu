const configuredBaseUrl = (import.meta as ImportMeta & { env: { VITE_API_URL?: string } }).env.VITE_API_URL;
const API_URL = (configuredBaseUrl ?? "").replace(/\/$/, "");

export type Team = { id: string; name: string; season: string; category?: string };
export type CurrentUser = {
  id: string; name: string; email: string;
  role: "club_admin" | "coordinator" | "coach";
  sport_role: string | null; global_access: boolean; teams: Team[];
};
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
export type TeamRecord = {
  id: string; record_type: "training" | "match"; happened_at: string;
  content: { summary: string; outcome?: string | null; nextObjectives?: string[] };
  created_at: string; created_by_name?: string;
};
export type CoordinatorOverview = {
  teams: Array<Team & { staff_count: number; record_count: number; last_activity_at: string | null }>;
  pendingProposals: Array<{ id: string; reason: string; proposed_at: string; proposed_by_name: string }>;
};
export type TeamPlan = { id: string; season: string; version: number; content: { seasonObjectives: string[]; nextTrainingObjectives: string[]; notes: string } };
export type AssistantResult = { id: string; user_message: string; assistant_message: string; created_at: string; requested_by: string };

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  login: (email: string) => request<{ token: string }>("/v1/session", { method: "POST", body: JSON.stringify({ email }) }),
  me: (token: string) => request<CurrentUser>("/v1/me", {}, token),
  teams: (token: string) => request<{ teams: Team[] }>("/v1/teams", {}, token),
  chat: (token: string, teamId: string, message: string, history: ChatMessage[]) =>
    request<{ id: string; content: string; createdAt: string }>("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ teamId, message, history: history.slice(-10).map(({ role, content }) => ({ role, content })) }),
    }, token),
  records: (token: string, teamId: string) => request<{ records: TeamRecord[] }>(`/v1/teams/${teamId}/records`, {}, token),
  createRecord: (token: string, teamId: string, record: { type: "training" | "match"; happenedAt: string; summary: string; outcome?: string; nextObjectives: string[] }) =>
    request<TeamRecord>(`/v1/teams/${teamId}/records`, { method: "POST", body: JSON.stringify(record) }, token),
  coordinatorOverview: (token: string) => request<CoordinatorOverview>("/v1/coordinator/overview", {}, token),
  plan: (token: string, teamId: string) => request<{ plan: TeamPlan | null }>(`/v1/teams/${teamId}/plan`, {}, token),
  savePlan: (token: string, teamId: string, plan: { seasonObjectives: string[]; nextTrainingObjectives: string[]; notes: string; version?: number }) => request<TeamPlan>(`/v1/teams/${teamId}/plan`, { method: "PUT", body: JSON.stringify(plan) }, token),
  assistantResults: (token: string, teamId: string) => request<{ results: AssistantResult[] }>(`/v1/teams/${teamId}/assistant-results`, {}, token),
};
