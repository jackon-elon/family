import type {
  User,
  PersonView,
  LoginSession,
  GuestFamilyData,
  OnboardingPreview,
  UserProfile,
} from "./types";
import { retryDelay } from "./shared/retry";
const base = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
let csrfToken = "";
let guestGeneration = 0;
let accountGeneration = 0;
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function assetUrl(url?: string): string | undefined {
  return url?.startsWith("/api/") ? `${base}${url}` : url;
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const accountVersion = accountGeneration;
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("暂时连接不上服务，请检查网络后重试。", "NETWORK");
  }
  let envelope: {
    ok: boolean;
    data?: T & { csrfToken?: string };
    error?: { message?: string; code?: string; retryAfterSeconds?: number };
  };
  try {
    envelope = await response.json();
  } catch {
    throw new ApiError(
      response.status === 429
        ? "请求较多，请稍后重试。"
        : "服务响应异常，请稍后重试。",
      response.status === 429 ? "RATE_LIMITED" : "BAD_RESPONSE",
      response.status,
      response.status === 429
        ? retryDelay(response.headers.get("Retry-After"))
        : undefined,
    );
  }
  if (!response.ok || !envelope.ok) {
    if (
      accountVersion === accountGeneration &&
      envelope.error?.code === "FORBIDDEN"
    )
      window.dispatchEvent(new Event("permissions-stale"));
    if (
      accountVersion === accountGeneration &&
      (envelope.error?.code === "UNAUTHENTICATED" ||
        envelope.error?.code === "ACCOUNT_NOT_INVITED")
    )
      window.dispatchEvent(
        new CustomEvent("session-expired", {
          detail: envelope.error,
        }),
      );
    throw new ApiError(
      envelope.error?.message || "操作未完成，请重试。",
      envelope.error?.code || "SERVER_ERROR",
      response.status,
      response.status === 429
        ? retryDelay(
            envelope.error?.retryAfterSeconds ??
              response.headers.get("Retry-After"),
          )
        : undefined,
    );
  }
  if (accountVersion === accountGeneration && envelope.data?.csrfToken)
    csrfToken = envelope.data.csrfToken;
  return envelope.data as T;
}
export const rpc = <T = any>(
  action: string,
  payload: unknown = {},
): Promise<T> => request<T>("/rpc", { action, payload });
function accountSession<T>(path: string, body: unknown): Promise<T> {
  guestGeneration++;
  accountGeneration++;
  return request<T>(path, body);
}
export const auth = {
  me: () => request<{ user: User; csrfToken?: string }>("/auth/me"),
  login: (
    phone: string,
    password: string,
    remember = false,
    inviteToken?: string,
  ) =>
    accountSession<{ user: User }>("/auth/login", {
      phone,
      password,
      remember,
      ...(inviteToken ? { inviteToken } : {}),
    }),
  register: (
    phone: string,
    password: string,
    inviteToken: string,
    remember = false,
  ) =>
    accountSession<{ user: User }>("/auth/register", {
      phone,
      password,
      inviteToken,
      remember,
    }),
  logout: () => accountSession("/auth/logout", {}),
  password: (currentPassword: string, newPassword: string) =>
    request("/auth/password", { currentPassword, newPassword }),
  sessions: () => request<{ sessions: LoginSession[] }>("/auth/sessions"),
  revokeSession: (sessionId: string) =>
    request<{ currentRevoked: boolean }>("/auth/sessions/revoke", {
      sessionId,
    }),
  revokeOtherSessions: () =>
    request<{ revokedCount: number }>("/auth/sessions/revoke-others", {}),
  reauthenticate: (password: string) =>
    request<{ reauthenticatedUntil: number }>("/auth/reauthenticate", {
      password,
    }),
};
export const onboarding = {
  preview: (inviteToken: string) =>
    request<OnboardingPreview>("/onboarding/preview", { inviteToken }),
  importProfile: (payload: {
    inviteToken: string;
    personId: string;
    personUpdatedAt: number;
    profileVersion: string;
  }) => request<{ profile: UserProfile | null }>("/onboarding/import", payload),
};
async function guestView(
  path: string,
  body?: unknown,
  version = guestGeneration,
) {
  try {
    const data = await request<GuestFamilyData>(path, body);
    if (version !== guestGeneration)
      throw new ApiError(
        "浏览的家庭已变化，请重新打开。",
        "STALE_GUEST_REQUEST",
      );
    return {
      ...data,
      receivedAt: Date.now(),
      persons: data.persons.map((person) => ({
        ...person,
        photoUrl: assetUrl(person.photoUrl),
      })),
    };
  } catch (err) {
    if (
      version === guestGeneration &&
      err instanceof ApiError &&
      err.code === "GUEST_SESSION_EXPIRED"
    )
      window.dispatchEvent(new Event("guest-session-expired"));
    throw err;
  }
}
export const guest = {
  enter: (familyName: string) =>
    guestView("/guest/enter", { familyName }, ++guestGeneration),
  family: () => guestView("/guest/family"),
  logout: () => {
    guestGeneration++;
    return request("/guest/logout", {});
  },
};
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作未完成，请重试。";
export const uncertainResult = (e: unknown) =>
  e instanceof ApiError &&
  (e.code === "NETWORK" ||
    e.code === "BAD_RESPONSE" ||
    e.code === "SERVER_ERROR" ||
    (e.status ?? 0) >= 500);
export const requestId = () => crypto.randomUUID();
export async function withPhotos(
  circleId: string,
  people: PersonView[],
): Promise<PersonView[]> {
  const selected = people.filter((p) => p.hasPhoto);
  const urls: Record<string, string> = {};
  for (let i = 0; i < selected.length; i += 20) {
    const batch = await rpc<{ urls: Record<string, string> }>("photo.urls", {
      circleId,
      personIds: selected.slice(i, i + 20).map((p) => p.id),
    });
    Object.assign(urls, batch.urls);
  }
  return people.map((p) => ({ ...p, photoUrl: assetUrl(urls[p.id]) }));
}
export async function preparePhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 12 * 1024 * 1024) throw new Error("图片请小于 12 MB。");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂不支持处理照片。");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86).split(",")[1];
  } finally {
    bitmap.close();
  }
}
export const uploadPhoto = (
  base64: string,
  target: { circleId?: string; personId?: string } = {},
) => request("/photos", { base64, ...target });
