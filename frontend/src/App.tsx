import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  BookOpen,
  UserRound,
  ArrowUpRight,
  Search,
  MapPin,
  Cake,
  ChevronRight,
  Network,
  UsersRound,
  Map,
  Settings2,
  LogOut,
  ShieldCheck,
  Heart,
  KeyRound,
  MonitorSmartphone,
  Camera,
  ZoomIn,
} from "lucide-react";
import {
  auth,
  guest,
  ApiError,
  assetUrl,
  errorText,
  rpc,
  uploadPhoto,
  onboarding,
} from "./api";
import type {
  ApplicationView,
  BirthdayEvent,
  CircleView,
  PersonView,
  User,
  UserProfile,
  LoginSession,
  BrowsePerson,
  FamilyBrowseData,
  GuestFamilyData,
  GuestBirthdays,
  OnboardingPreview,
} from "./types";
import {
  Alert,
  Avatar,
  Back,
  Empty,
  Loading,
  Modal,
  FloatingPanel,
} from "./components/UI";
import ProfileForm, {
  draftOf,
  patchOf,
  profilePhone,
} from "./components/ProfileForm";
import FamilyGraph from "./components/FamilyGraph";
import ContactActions from "./components/ContactActions";
import { relationshipFor } from "./shared/relationship";
import { citySummary } from "./shared/geography";
import { matchesPerson } from "./shared/person-search";
import {
  albumViewReducer,
  initialAlbumView,
  type AlbumTab,
} from "./shared/album-view";
import { useCircle } from "./hooks";
import { useFamilyBirthdays } from "./use-family-birthdays";
import { guestBrowseData } from "./shared/guest-view";
import {
  birthdayCountdown,
  birthdayRefreshDelay,
  guestSessionDelay,
  birthdayDateDescription,
} from "./shared/guest-birthdays";
import Manage from "./Manage";
import { invitationCanApply } from "./shared/onboarding";
import { retryDelay, retryLabel, retryRemaining } from "./shared/retry";
import { AppContext as Context, useApp } from "./app-context";
import {
  inviteTokenFromPath,
  performSensitiveAction,
  createPermissionRefresh,
} from "./shared/session-actions";

const PersonMap = lazy(() => import("./components/PersonMap"));

function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-mark">✧</span>
      <span>
        人间星图<small>把牵挂，记在一起</small>
      </span>
    </Link>
  );
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [guestFamily, setGuestFamily] = useState<GuestFamilyData | null>(null),
    [checking, setChecking] = useState(true),
    [authError, setAuthError] = useState(""),
    [circles, setCircles] = useState<CircleView[]>([]),
    [circlesLoading, setCirclesLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [toast, setToast] = useState(""),
    [reauthOpen, setReauthOpen] = useState(false);
  const nav = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const accountRef = useRef<User | null>(null),
    refreshGeneration = useRef(0);
  const guestRef = useRef<GuestFamilyData | null>(null);
  guestRef.current = guestFamily;
  accountRef.current = user;
  const reauthPending = useRef<((confirmed: boolean) => void) | null>(null);
  const finishReauth = useCallback((confirmed: boolean) => {
    const resolve = reauthPending.current;
    reauthPending.current = null;
    setReauthOpen(false);
    resolve?.(confirmed);
  }, []);
  const confirmSensitive = useCallback(
    async (operation: () => Promise<unknown>) => {
      const accountId = accountRef.current?.id;
      return performSensitiveAction(
        () => {
          if (!accountId || accountRef.current?.id !== accountId)
            throw new Error("登录状态已变化，请重新操作。");
          return operation();
        },
        () =>
          new Promise<boolean>((resolve) => {
            if (
              !accountId ||
              accountRef.current?.id !== accountId ||
              reauthPending.current
            )
              return resolve(false);
            reauthPending.current = resolve;
            setReauthOpen(true);
          }),
      );
    },
    [],
  );
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4000);
  }, []);
  const refresh = useCallback(async () => {
    const accountId = accountRef.current?.id;
    if (!accountId) return;
    const version = ++refreshGeneration.current;
    setCirclesLoading(true);
    try {
      const [identity, d] = await Promise.all([
        auth.me(),
        rpc<{ circles: CircleView[] }>("circle.list"),
      ]);
      if (
        version === refreshGeneration.current &&
        accountRef.current?.id === accountId
      ) {
        if (identity.user.id !== accountId) return;
        accountRef.current = identity.user;
        setUser(identity.user);
        setCircles(d.circles.filter((circle) => circle.type === "family"));
        setLoadError("");
      }
    } catch (e) {
      if (
        version === refreshGeneration.current &&
        accountRef.current?.id === accountId
      ) {
        setLoadError(errorText(e));
        throw e;
      }
    } finally {
      if (version === refreshGeneration.current) setCirclesLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    let booting = true;
    auth
      .me()
      .then((d) => {
        if (active) setUser(d.user);
      })
      .catch(async (e) => {
        if (!active) return;
        const accessDenied =
          e instanceof ApiError && e.code === "ACCOUNT_NOT_INVITED";
        if (accessDenied) setAuthError(errorText(e));
        if (!(e instanceof ApiError && (e.status === 401 || accessDenied))) {
          setAuthError(errorText(e));
          return;
        }
        try {
          const snapshot = await guest.family();
          if (active) {
            setGuestFamily(snapshot);
            if (location.pathname === "/" || location.pathname === "/guest")
              nav("/guest", { replace: true });
          }
        } catch (guestError) {
          if (
            active &&
            !accessDenied &&
            !(
              guestError instanceof ApiError &&
              guestError.code === "GUEST_SESSION_EXPIRED"
            )
          )
            setAuthError(errorText(guestError));
          if (
            active &&
            accessDenied &&
            !location.pathname.startsWith("/invite/")
          )
            nav("/login", { replace: true });
        }
      })
      .finally(() => {
        booting = false;
        if (active) setChecking(false);
      });
    const expired = (event: Event) => {
      const reason = (event as CustomEvent<{ code?: string; message?: string }>)
        .detail;
      const hadAccount = !!accountRef.current;
      finishReauth(false);
      accountRef.current = null;
      refreshGeneration.current++;
      setUser(null);
      setCircles([]);
      setCirclesLoading(true);
      setLoadError("");
      if (hadAccount || reason?.code === "ACCOUNT_NOT_INVITED") {
        setAuthError(reason?.message || "登录已失效，请重新登录。");
        if (!booting && !locationRef.current.pathname.startsWith("/invite/"))
          nav("/login", { replace: true });
      }
    };
    const guestExpired = () => {
      if (!guestRef.current) return;
      guestRef.current = null;
      setGuestFamily(null);
      setAuthError("游客浏览已结束，请重新输入家庭名称。");
    };
    window.addEventListener("session-expired", expired);
    window.addEventListener("guest-session-expired", guestExpired);
    return () => {
      active = false;
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("guest-session-expired", guestExpired);
      clearTimeout(timer.current);
      reauthPending.current?.(false);
      reauthPending.current = null;
    };
  }, []);
  useEffect(() => {
    if (!guestFamily) return;
    const expiration = setTimeout(
      () => window.dispatchEvent(new Event("guest-session-expired")),
      guestSessionDelay(guestFamily),
    );
    return () => clearTimeout(expiration);
  }, [guestFamily]);
  useEffect(() => {
    if (user) refresh().catch((e) => setLoadError(errorText(e)));
  }, [user?.id, refresh]);
  useEffect(() => {
    const sync = createPermissionRefresh(() => accountRef.current?.id, refresh);
    const permissionsChanged = () => {
      void sync();
    };
    window.addEventListener("permissions-stale", permissionsChanged);
    return () =>
      window.removeEventListener("permissions-stale", permissionsChanged);
  }, [refresh]);
  const logout = async () => {
    finishReauth(false);
    await auth.logout();
    accountRef.current = null;
    refreshGeneration.current++;
    setUser(null);
    setGuestFamily(null);
    setAuthError("");
    setCircles([]);
    setCirclesLoading(true);
    setLoadError("");
    nav("/");
  };
  if (checking)
    return (
      <div className="boot">
        <Brand />
        <Loading label="打开亲友录…" />
      </div>
    );
  if (!user && guestFamily && location.pathname === "/guest")
    return (
      <GuestHome
        snapshot={guestFamily}
        onRefresh={setGuestFamily}
        onExit={async (login) => {
          await guest.logout();
          guestRef.current = null;
          setGuestFamily(null);
          setAuthError("");
          nav(login ? "/login" : "/");
        }}
      />
    );
  if (!user)
    return (
      <Auth
        onSuccess={(next) => {
          refreshGeneration.current++;
          accountRef.current = next;
          guestRef.current = null;
          setGuestFamily(null);
          setUser(next);
          setAuthError("");
          if (!location.pathname.startsWith("/invite/"))
            nav("/", { replace: true });
        }}
        onGuest={(snapshot) => {
          setGuestFamily(snapshot);
          setAuthError("");
          nav("/guest");
        }}
        initialError={authError}
      />
    );
  return (
    <Context.Provider
      value={{
        user,
        circles,
        circlesLoading,
        circlesError: loadError,
        refresh,
        logout,
        notify,
        confirmSensitive,
      }}
    >
      <div className="app-shell">
        <aside className="sidebar">
          <Brand />
          <div className="nav-caption">生活中的联系</div>
          <nav>
            <Link
              className={
                location.pathname === "/" ||
                location.pathname.startsWith("/album")
                  ? "active"
                  : ""
              }
              to="/"
            >
              <BookOpen size={21} />
              亲友录
            </Link>
            <Link
              className={
                location.pathname.startsWith("/me") ||
                location.pathname.startsWith("/manage")
                  ? "active"
                  : ""
              }
              to="/me"
            >
              <UserRound size={21} />
              我的
            </Link>
          </nav>
          <div className="sidebar-note">
            <span>
              山川异域，
              <br />
              牵挂同心。
            </span>
            <p>每一个名字，都有一份联系。</p>
          </div>
          <div className="sidebar-account">
            <span className="tiny-dot" />
            {user.access === "invited" ? "受邀加入" : "已登录"} ·{" "}
            {user.phone.slice(0, 3)}****{user.phone.slice(-4)}
          </div>
        </aside>
        <main className="main">
          <header className="mobile-header">
            <Brand />
          </header>
          {loadError && (
            <div className="page">
              <Alert message={loadError} />
              <button
                className="text-button"
                onClick={() =>
                  refresh().catch((e) => setLoadError(errorText(e)))
                }
              >
                重新加载
              </button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/me" element={<Me />} />
            {user.access === "member" && (
              <>
                <Route path="/album/:circleId" element={<Album />} />
                <Route path="/manage/:circleId" element={<ManagementRoute />} />
              </>
            )}
            <Route path="/invite/:token" element={<Join />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <nav className="mobile-nav">
          <Link
            className={
              !location.pathname.startsWith("/me") &&
              !location.pathname.startsWith("/manage")
                ? "active"
                : ""
            }
            to="/"
          >
            <BookOpen size={21} />
            亲友录
          </Link>
          <Link
            className={
              location.pathname.startsWith("/me") ||
              location.pathname.startsWith("/manage")
                ? "active"
                : ""
            }
            to="/me"
          >
            <UserRound size={21} />
            我的
          </Link>
        </nav>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        {reauthOpen && (
          <ReauthenticateDialog
            onClose={() => finishReauth(false)}
            onVerified={() => finishReauth(true)}
          />
        )}
      </div>
    </Context.Provider>
  );
}
function ManagementRoute() {
  const { circleId } = useParams();
  const { circles, circlesLoading, circlesError } = useApp();
  const circle = circles.find((item) => item.id === circleId);
  return (
    <ManagementAccess
      role={circle?.role}
      loading={circlesLoading && !circle}
      error={circlesError}
    >
      <Manage key={`${circleId}-${circle?.role}`} />
    </ManagementAccess>
  );
}

export function ManagementAccess({
  role,
  loading,
  error,
  children,
}: {
  role?: CircleView["role"];
  loading: boolean;
  error: string;
  children: ReactNode;
}) {
  if (role === "owner" || role === "admin") return children;
  return (
    <div className="page">
      {loading ? (
        <Loading label="正在确认管理权限…" />
      ) : (
        <Empty title={error ? "暂时无法确认管理权限" : "此页面仅供管理员使用"}>
          <Link className="button secondary" to="/me">
            返回我的
          </Link>
        </Empty>
      )}
    </div>
  );
}

export function Auth({
  onSuccess,
  onGuest,
  initialError,
}: {
  onSuccess: (user: User) => void;
  onGuest: (snapshot: GuestFamilyData) => void;
  initialError: string;
}) {
  const pathname = useLocation().pathname;
  const inviteToken = inviteTokenFromPath(pathname);
  const acceptingInvite = pathname.startsWith("/invite/");
  const [entry, setEntry] = useState<"guest" | "account">(
    acceptingInvite || /^\/(login|me|manage|album)(\/|$)/.test(pathname)
      ? "account"
      : "guest",
  );
  const [familyName, setFamilyName] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login"),
    [phone, setPhone] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [remember, setRemember] = useState(false),
    [invitation, setInvitation] = useState<{
      token: string;
      circle: { name: string; type: string };
      status: string;
      canRegister?: boolean;
    } | null>(null),
    [inviteLoading, setInviteLoading] = useState(!!inviteToken),
    [inviteError, setInviteError] = useState(""),
    [inviteRetry, setInviteRetry] = useState(0),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  const locking = useRef(false);
  const [showPassword, setShowPassword] = useState(false);
  const [cooldown, setCooldown] = useState({ guest: 0, account: 0 });
  const [clock, setClock] = useState(Date.now);
  const remaining = retryRemaining(cooldown[entry], clock);
  useEffect(() => {
    if (cooldown[entry] && remaining === 0) {
      setCooldown((current) => ({ ...current, [entry]: 0 }));
      setError("");
    }
  }, [cooldown, entry, remaining]);
  useEffect(() => {
    const end = Math.max(cooldown.guest, cooldown.account);
    if (end <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= end) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);
  const captureCooldown = (err: unknown) => {
    if (!(err instanceof ApiError) || err.status !== 429) return;
    const now = Date.now();
    setClock(now);
    setCooldown((current) => ({
      ...current,
      [entry]: now + retryDelay(err.retryAfterSeconds) * 1000,
    }));
  };
  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);
  useEffect(() => {
    setEntry(
      acceptingInvite || /^\/(login|me|manage|album)(\/|$)/.test(pathname)
        ? "account"
        : "guest",
    );
  }, [pathname, acceptingInvite]);
  useEffect(() => {
    let active = true;
    setMode("login");
    setInvitation(null);
    setInviteError("");
    setInviteLoading(!!inviteToken);
    if (!inviteToken) return;
    rpc<{
      circle: { name: string; type: string };
      status: string;
      canRegister?: boolean;
    }>("invite.preview", { token: inviteToken })
      .then((result) => {
        if (active) setInvitation({ ...result, token: inviteToken });
      })
      .catch((err) => {
        if (active) setInviteError(errorText(err));
      })
      .finally(() => {
        if (active) setInviteLoading(false);
      });
    return () => {
      active = false;
    };
  }, [inviteToken, inviteRetry]);
  const canRegister =
    !!inviteToken &&
    invitation?.token === inviteToken &&
    invitation.status === "active" &&
    invitation.canRegister !== false &&
    invitation.circle.type === "family";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locking.current || retryRemaining(cooldown[entry]) > 0) return;
    if (entry === "guest") {
      locking.current = true;
      setBusy(true);
      setError("");
      try {
        onGuest(await guest.enter(familyName.trim()));
      } catch (err) {
        captureCooldown(err);
        setError(errorText(err));
      } finally {
        locking.current = false;
        setBusy(false);
      }
      return;
    }
    if (mode === "register" && !canRegister) {
      setError("请通过有效的家人邀请注册。");
      return;
    }
    if (mode === "register" && password !== confirm) {
      setError("两次密码不一致。");
      return;
    }
    locking.current = true;
    setBusy(true);
    setError("");
    try {
      const loginPhone = profilePhone(phone);
      const d =
        mode === "register"
          ? await auth.register(loginPhone, password, inviteToken!, remember)
          : await auth.login(
              loginPhone,
              password,
              remember,
              inviteToken || undefined,
            );
      setPassword("");
      setConfirm("");
      onSuccess(d.user);
    } catch (err) {
      captureCooldown(err);
      if (
        mode === "register" &&
        err instanceof ApiError &&
        err.code === "ACCOUNT_EXISTS"
      ) {
        setMode("login");
        setPassword("");
        setConfirm("");
        setError("该手机号已有账号，请使用原密码登录，继续这份邀请。");
        return;
      }
      if (
        mode === "register" &&
        err instanceof ApiError &&
        /INVITE|REGISTRATION_DISABLED/.test(err.code)
      ) {
        setInvitation(null);
        setMode("login");
        setInviteError(errorText(err));
      }
      setError(errorText(err));
    } finally {
      locking.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="auth-screen">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-main">
          <p className="eyebrow">亲缘相系 · 家人常念</p>
          <h1>
            无论相隔多远，
            <br />
            总有一份<span>牵挂。</span>
          </h1>
          <p>
            记下家人的关系与近况。
            <br />
            在一张地图上，看看大家的所在。
          </p>
          <div className="orbit-decoration" aria-hidden="true">
            <span>家人</span>
            <span>牵挂</span>
            <span>故乡</span>
            <i />
            <b>✧</b>
          </div>
        </div>
        <small>人间星图 · 让熟悉的名字，常在身边</small>
      </section>
      <section className="auth-panel">
        <form onSubmit={submit} className="auth-form">
          <div className="auth-mobile-brand">
            <Brand />
          </div>
          {!acceptingInvite && (
            <div className="segmented" aria-label="选择进入方式">
              <button
                type="button"
                className={entry === "guest" ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setEntry("guest");
                  setError("");
                  setPassword("");
                  setConfirm("");
                  setShowPassword(false);
                }}
              >
                游客看看
              </button>
              <button
                type="button"
                className={entry === "account" ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setEntry("account");
                  setError("");
                }}
              >
                账号登录
              </button>
            </div>
          )}
          {entry === "guest" ? (
            <>
              <p className="eyebrow">家人常念 · 随时看看</p>
              <h2>翻开家人的亲友录</h2>
              <p className="muted">
                输入家庭名称，看看家人的关系、近况和所在。
              </p>
              <Alert message={error} />
              <fieldset disabled={busy}>
                <label>
                  家庭名称
                  <input
                    required
                    maxLength={60}
                    value={familyName}
                    autoComplete="off"
                    placeholder="请输入完整的家庭名称"
                    onChange={(event) => setFamilyName(event.target.value)}
                  />
                </label>
                <button
                  className="button primary full"
                  type="submit"
                  disabled={remaining > 0}
                >
                  {busy
                    ? "正在打开…"
                    : remaining > 0
                      ? retryLabel(remaining)
                      : "进去看看"}
                  <ArrowUpRight size={18} />
                </button>
              </fieldset>
              <p className="hint">
                游客可以查看家人资料。需要修改时，请使用家人账号登录。
              </p>
            </>
          ) : (
            <>
              <p className="eyebrow">
                {acceptingInvite ? "有人邀请你相聚" : "欢迎回来"}
              </p>
              <h2>
                {mode === "login" ? "打开你的亲友录" : "从这里，记下牵挂"}
              </h2>
              <p className="muted">
                {acceptingInvite
                  ? "登录或注册后，继续打开这份邀请。填写资料并经管理员确认后即可加入。"
                  : mode === "login"
                    ? "登录后，看看家人的近况。"
                    : "使用家人填写的手机号注册，已有资料可以直接带入。"}
              </p>
              {acceptingInvite && (
                <div className="auth-invitation">
                  {inviteLoading ? (
                    <Loading label="正在查看家人的邀请…" />
                  ) : canRegister ? (
                    <p>
                      来自「{invitation!.circle.name}
                      」的邀请。已有账号可直接登录。
                    </p>
                  ) : (
                    <>
                      <Alert
                        message={
                          inviteError ||
                          "这份邀请暂不能用于注册，请联系管理员重新邀请。已加入家庭或已接受此邀请的账号，可使用原密码登录。"
                        }
                      />
                      {inviteError && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => setInviteRetry((value) => value + 1)}
                        >
                          重新查看邀请
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {canRegister ? (
                <div className="segmented">
                  <button
                    type="button"
                    className={mode === "login" ? "active" : ""}
                    disabled={busy}
                    onClick={() => {
                      setMode("login");
                      setError("");
                    }}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    className={mode === "register" ? "active" : ""}
                    disabled={busy}
                    onClick={() => {
                      setMode("register");
                      setError("");
                    }}
                  >
                    注册
                  </button>
                </div>
              ) : (
                !acceptingInvite && (
                  <p className="soft-note">
                    账号需经家人管理员邀请。新成员请打开邀请链接或扫描邀请二维码注册。
                  </p>
                )
              )}
              <Alert message={error} />
              <fieldset disabled={busy}>
                <label>
                  手机号
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="username"
                    required
                    placeholder="国内手机号，或带区号的海外号码"
                    maxLength={30}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.trim())}
                  />
                </label>
                <label>
                  密码
                  <input
                    type={showPassword ? "text" : "password"}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    required
                    minLength={10}
                    maxLength={128}
                    pattern={
                      mode === "register"
                        ? "(?=.*[A-Za-z])(?=.*[0-9]).{10,128}"
                        : undefined
                    }
                    placeholder="至少 10 位，包含字母和数字"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                {mode === "register" && (
                  <label>
                    确认密码
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                )}
                <label className="checkbox password-visibility">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(event) => setShowPassword(event.target.checked)}
                  />
                  显示密码
                </label>
                <label className="checkbox remember-login">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  <span>
                    这是我的手机，记住登录90天
                    <small>未勾选时，登录有效期为7天。</small>
                  </span>
                </label>
                <button
                  className="button primary full"
                  type="submit"
                  disabled={remaining > 0}
                >
                  {busy
                    ? "请稍候…"
                    : remaining > 0
                      ? retryLabel(remaining)
                      : mode === "login"
                        ? "登录亲友录"
                        : "创建账号"}
                  <ArrowUpRight size={18} />
                </button>
              </fieldset>
              <p className="hint">
                {mode === "register"
                  ? "手机号用于账号登录；加入亲友录需要管理员邀请。"
                  : "请妥善保存密码，短信找回暂未接入。"}
              </p>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
function GuestHome({
  snapshot,
  onRefresh,
  onExit,
}: {
  snapshot: GuestFamilyData;
  onRefresh: (snapshot: GuestFamilyData) => void;
  onExit: (login: boolean) => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [birthdaysStale, setBirthdaysStale] = useState(false);
  const active = useRef(true),
    locking = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    if (locking.current) return;
    locking.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (err) {
      if (active.current) setError(errorText(err));
    } finally {
      locking.current = false;
      if (active.current) setBusy(false);
    }
  };
  const reload = () =>
    run(async () => {
      const next = await guest.family();
      if (active.current) onRefresh(next);
    });
  useEffect(() => {
    const delay = birthdayRefreshDelay(snapshot);
    if (delay === null) {
      // Older API responses can still be browsed during a rolling deployment.
      // A manual family refresh will pick up birthdays once the server updates.
      setBirthdaysStale(false);
      return;
    }
    const refreshAfterMidnight = () => {
      if (birthdayRefreshDelay(snapshot) !== 0) return;
      setBirthdaysStale(true);
      void reload();
    };
    setBirthdaysStale(delay === 0);
    const timer = window.setTimeout(refreshAfterMidnight, delay + 25);
    const visible = () => {
      if (!document.hidden) refreshAfterMidnight();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refreshAfterMidnight);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", refreshAfterMidnight);
    };
  }, [snapshot]);
  const data = useMemo(() => guestBrowseData(snapshot), [snapshot]);
  return (
    <div className="guest-shell">
      <header className="guest-header">
        <Brand />
        <div className="guest-session">
          <span>游客浏览 · 登录后维护资料</span>
          <div className="actions">
            <button
              className="button secondary small-button"
              disabled={busy}
              onClick={() => run(() => onExit(true))}
            >
              <UserRound size={16} />
              账号登录
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => run(() => onExit(false))}
            >
              <LogOut size={16} />
              退出游客
            </button>
          </div>
        </div>
      </header>
      <main>
        <div className="guest-refresh">
          <button className="text-button" disabled={busy} onClick={reload}>
            {busy ? "请稍候…" : "刷新家人资料"}
          </button>
        </div>
        <FamilyAlbum
          key={snapshot.family.id}
          circleId={snapshot.family.id}
          data={data}
          error={error}
          loading={false}
          load={reload}
          readOnly
          birthdays={snapshot.birthdays}
          birthdaysStale={birthdaysStale}
        />
      </main>
    </div>
  );
}

export function GuestBirthdayList({
  birthdays,
  stale,
  onSelect,
  onRetry,
  people = [],
}: {
  people?: BrowsePerson[];
  birthdays: GuestBirthdays;
  stale: boolean;
  onSelect: (personId: string) => void;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const renderBirthday = (event: BirthdayEvent) => (
    <button
      type="button"
      key={event.personId}
      className={`birthday-item${event.daysUntil === 0 ? " is-today" : ""}`}
      onClick={() => {
        setExpanded(false);
        onSelect(event.personId);
      }}
    >
      <h3>
        <Avatar
          person={
            people.find((p) => p.id === event.personId) || {
              name: event.personName,
            }
          }
        />
        {people.find((p) => p.id === event.personId)?.name || event.personName}
      </h3>
      <p>{birthdayDateDescription(event)}</p>
      <span className="birthday-count">
        {birthdayCountdown(event.daysUntil)}
      </span>
    </button>
  );
  return (
    <section className="birthday-section guest-birthdays" aria-label="近期生日">
      <div className="section-heading">
        <h2>
          <Cake size={20} />
          近期生日
        </h2>
        <span className="muted small">未来 30 天 · 按北京时间</span>
      </div>
      {(stale || birthdays.error) && (
        <p className="soft-note" role="status">
          {stale ? "日期已变化，请刷新查看今天的生日。" : birthdays.error}
          <button className="text-button" onClick={onRetry}>
            刷新生日
          </button>
        </p>
      )}
      {!stale &&
        (birthdays.events.length ? (
          <>
            <div className="birthday-list">
              {birthdays.events.slice(0, 3).map(renderBirthday)}
            </div>
            {birthdays.events.length > 3 && (
              <button
                className="button secondary birthday-show-all"
                onClick={() => setExpanded(true)}
              >
                查看全部生日（{birthdays.events.length} 人）
              </button>
            )}
          </>
        ) : (
          !birthdays.error && (
            <p className="soft-note">
              未来 30 天暂无家人生日。农历生日也会按当年日期换算。
            </p>
          )
        ))}
      {expanded && (
        <Modal
          title="近期生日"
          className="birthday-dialog"
          onClose={() => setExpanded(false)}
        >
          <p className="birthday-dialog-caption">
            未来 30 天 · {birthdays.events.length} 位家人
          </p>
          <div
            className="birthday-dialog-scroll"
            role="region"
            aria-label="全部生日列表"
            tabIndex={0}
          >
            {stale || birthdays.error ? (
              <p className="soft-note">
                {birthdays.error || "日期已变化，请关闭后刷新生日。"}
              </p>
            ) : (
              <div className="birthday-list is-expanded">
                {birthdays.events.map(renderBirthday)}
              </div>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

function Home() {
  const { user, refresh } = useApp();
  return user.access === "invited" ? (
    <InvitationHome invitation={user.invitation} refresh={refresh} />
  ) : (
    <MemberHome />
  );
}

export function InvitationHome({
  invitation,
  refresh,
}: {
  invitation?: User["invitation"];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = invitation?.status === "pending";
  return (
    <div className="page join-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">有人为你留了一份牵挂</p>
          <h1>{pending ? "等待家人确认" : "继续与家人相聚"}</h1>
        </div>
      </header>
      <section className="join-card">
        <span className="album-icon">
          <Heart />
        </span>
        <h2>{invitation?.circleName || "家人的邀请"}</h2>
        <p className="soft-note">
          {pending
            ? "申请已送达，管理员确认后就可以打开亲友录。"
            : "你已收到家人邀请。请重新打开管理员发来的原邀请链接，确认是否已有你的资料，再提交加入申请。"}
        </p>
        <Link className="button primary" to="/me">
          {pending ? "查看我的资料与申请" : "查看我的资料"}
          <ChevronRight size={16} />
        </Link>
        {invitation && (
          <p className="hint">
            邀请有效至{" "}
            {new Date(invitation.expiresAt).toLocaleString("zh-CN", {
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
        <Alert message={error} />
        <button
          className="text-button"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await refresh();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "正在查看…" : "刷新加入状态"}
        </button>
      </section>
    </div>
  );
}

function MemberHome() {
  const { circles, circlesLoading, circlesError } = useApp();
  const {
    birthdays,
    loading: eventsLoading,
    load: reloadBirthdays,
  } = useFamilyBirthdays(undefined, circles);
  const events = birthdays?.events || [];
  const error = birthdays?.error || "";
  return (
    <div className="page home-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">每个名字，都是一份牵挂</p>
          <h1>
            亲友录<span className="title-dot">.</span>
          </h1>
          <p className="muted">家人常念，亲情常在。</p>
        </div>
      </header>
      {circles.some(
        (circle) => circle.role === "owner" && circle.personCount === 0,
      ) && (
        <div className="transfer-notice">
          <p>先完善我的资料，让家人在亲缘图里找到你。</p>
          <Link className="button secondary" to="/me">
            完善我的资料
            <ChevronRight size={16} />
          </Link>
        </div>
      )}
      <section className="home-intro">
        <div>
          <span className="pill">朝夕之间 · 人间相见</span>
          <h2>
            把身边的人，
            <br />
            好好记在心上。
          </h2>
          <p>
            亲缘有迹，近况可知。
            <br />
            让天南海北的联系，近一些。
          </p>
        </div>
        <div className="intro-art" aria-hidden="true">
          <div className="intro-ring ring-one" />
          <div className="intro-ring ring-two" />
          <span className="art-node node-one">亲</span>
          <span className="art-node node-two">友</span>
          <span className="art-node node-three">家</span>
          <span className="art-star">✧</span>
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>
            我的亲友录 <span>{circles.length}</span>
          </h2>
          <span className="muted small">熟悉的人，熟悉的故事</span>
        </div>
        {circlesLoading && !circles.length ? (
          <Loading label="正在打开亲友录…" />
        ) : circles.length ? (
          <div className="album-grid">
            {circles.map((c, i) => (
              <Link
                to={`/album/${c.id}`}
                key={c.id}
                className="album-card album-family"
              >
                <div className="album-card-top">
                  <span className="album-icon">
                    <Heart size={24} />
                  </span>
                  <ArrowUpRight size={20} />
                </div>
                <span className="eyebrow">家 人 录</span>
                <h3>{c.name}</h3>
                <p>枝叶相连，家人相伴</p>
                <div className="album-card-bottom">
                  <span>
                    <UsersRound size={15} />
                    {c.personCount} 位家人
                  </span>
                  <span>
                    翻开看看 <ChevronRight size={14} />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : !circlesError ? (
          <Empty title="等待与家人相聚">
            <p>
              请通过家人管理员发来的邀请链接加入。已提交的申请可在「我的」查看。
            </p>
            <Link className="button secondary" to="/me">
              查看我的资料与申请 <ChevronRight size={16} />
            </Link>
          </Empty>
        ) : null}
      </section>
      <section className="birthday-section">
        <div className="section-heading">
          <h2>
            <Cake size={20} />
            近期生日
          </h2>
          <span className="muted small">未来 30 天</span>
        </div>
        <Alert message={error} />
        {eventsLoading ? (
          <Loading label="正在查看近期生日…" />
        ) : error ? (
          <button
            className="text-button"
            onClick={() => void reloadBirthdays()}
          >
            重新加载生日
          </button>
        ) : events.length ? (
          <div className="birthday-list">
            {events.slice(0, 8).map((e) => (
              <Link
                key={`${e.circleId}-${e.personId}`}
                to={`/album/${e.circleId}?person=${e.personId}`}
                className="birthday-item"
              >
                <div className="birthday-date">
                  <b>{e.date.slice(8)}</b>
                  <span>{Number(e.date.slice(5, 7))} 月</span>
                </div>
                <div>
                  <h3>{e.personName}</h3>
                  <p>
                    {e.circleName} · {e.birthdayText}
                  </p>
                </div>
                <span className="birthday-count">
                  {e.daysUntil === 0 ? "今天生日" : `${e.daysUntil} 天后`}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="soft-note">
            近期没有家人生日。农历生日也会自动换算提醒。
          </p>
        )}
      </section>
      <footer className="page-footer">山川虽远，牵挂常在。</footer>
    </div>
  );
}

function Album() {
  const { circleId } = useParams();
  const { data, error, loading, load, setData } = useCircle(circleId);
  const birthdayState = useFamilyBirthdays(circleId, data?.people);
  return (
    <FamilyAlbum
      birthdays={birthdayState.birthdays}
      birthdaysLoading={birthdayState.loading}
      onBirthdayRetry={birthdayState.load}
      circleId={circleId}
      data={data}
      error={error}
      loading={loading}
      load={load}
      onRemark={(personId, remark) =>
        setData((prior) =>
          prior && prior.circle.id === circleId
            ? { ...prior, remarks: { ...prior.remarks, [personId]: remark } }
            : prior,
        )
      }
    />
  );
}

export function FamilyAlbum({
  circleId,
  data,
  error,
  loading,
  load,
  readOnly = false,
  onRemark,
  birthdays,
  birthdaysStale = false,
  birthdaysLoading = false,
  onBirthdayRetry,
}: {
  circleId?: string;
  data: FamilyBrowseData | null;
  error: string;
  loading: boolean;
  load: () => void;
  readOnly?: boolean;
  onRemark?: (personId: string, remark: string) => void;
  birthdays?: GuestBirthdays;
  birthdaysStale?: boolean;
  birthdaysLoading?: boolean;
  onBirthdayRetry?: () => void;
}) {
  const location = useLocation();
  const deepLinkPerson = new URLSearchParams(location.search).get("person");
  const [view, dispatchView] = useReducer(
    albumViewReducer,
    { circleId, navigationKey: location.key, person: deepLinkPerson },
    initialAlbumView,
  );
  const { tab, selected, anchor: selectedAnchor } = view;
  const [search, setSearch] = useState("");
  useEffect(() => {
    dispatchView({
      type: "navigate",
      circleId,
      navigationKey: location.key,
      person: deepLinkPerson,
    });
    setSearch("");
  }, [circleId, deepLinkPerson, location.key]);
  const people = useMemo(
    () =>
      data?.people.map((p) => ({
        ...p,
        originalName: p.name,
        name: (!readOnly && data.remarks[p.id]) || p.name,
      })) || [],
    [data, readOnly],
  );
  const labels = useMemo(() => {
    if (!data || readOnly) return {};
    const self = data.people.find((p) => p.isSelf);
    return Object.fromEntries(
      data.people.map((p) => [
        p.id,
        self
          ? relationshipFor(data.people, data.relations, self.id, p.id).label
          : "",
      ]),
    );
  }, [data, readOnly]);
  const filtered = people.filter((p) => matchesPerson(p, search, labels[p.id]));
  if (loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <Back onClick={() => history.back()} />
        <Alert message={error} />
        <button className="button secondary" onClick={load}>
          重试
        </button>
      </div>
    );
  const current =
    view.circleId === circleId && view.navigationKey === location.key
      ? data.people.find((p) => p.id === selected)
      : undefined;
  const activeTab = tab;
  const switchTab = (next: AlbumTab) =>
    dispatchView({ type: "tab", tab: next });
  const pick = (id: string, anchor?: HTMLElement) => {
    dispatchView({ type: "select", id, anchor });
  };
  return (
    <div className="page album-page">
      {!readOnly && (
        <nav className="album-backbar" aria-label="家庭导航">
          <Link to="/" className="album-back-link">
            ← 返回亲友录
          </Link>
        </nav>
      )}
      <header className="page-header">
        <div>
          <p className="eyebrow">家人相伴 · 枝叶相连</p>
          <h1>{data.circle.name}</h1>
          <p className="muted">
            {data.people.length} 位家人 ·{" "}
            {
              citySummary(data.people).groups.filter((group) => group.city)
                .length
            }{" "}
            座城市
          </p>
        </div>
      </header>
      <Alert message={error} />
      {birthdaysLoading && <Loading label="正在查看近期生日…" />}
      {birthdays && !birthdaysLoading && (
        <GuestBirthdayList
          birthdays={birthdays}
          people={people}
          stale={birthdaysStale}
          onRetry={onBirthdayRetry || load}
          onSelect={(id) => {
            if (!data.people.some((person) => person.id === id)) return;
            setSearch("");
            dispatchView({ type: "birthday", id });
          }}
        />
      )}
      {!readOnly && data.ownerTransfer?.isTarget && (
        <div className="transfer-notice">
          <p>管理员邀请你接手「{data.circle.name}」的创建者管理。</p>
          <Link className="button secondary" to="/me">
            前往我的处理
          </Link>
        </div>
      )}
      <div className="browse-toolbar">
        <div className="view-tabs">
          <button
            className={activeTab === "graph" ? "active" : ""}
            onClick={() => switchTab("graph")}
          >
            <Network size={17} />
            亲缘图
          </button>
          <button
            className={activeTab === "list" ? "active" : ""}
            onClick={() => switchTab("list")}
          >
            <BookOpen size={17} />
            家人簿
          </button>
          <button
            className={activeTab === "map" ? "active" : ""}
            onClick={() => switchTab("map")}
          >
            <Map size={17} />
            天南海北
          </button>
        </div>
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索成员"
            placeholder="搜索姓名、城市、近况"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              dispatchView({ type: "close" });
            }}
          />
        </label>
      </div>
      {!people.length ? (
        <Empty title="还没有成员资料">
          <p>
            {readOnly
              ? "家人资料还在整理中，稍后再来看看。"
              : "管理员可以在「我的 → 管理」添加家人。"}
          </p>
        </Empty>
      ) : search && !filtered.length ? (
        <Empty title="没有找到这位家人">
          <p>换一个姓名或城市试试。</p>
        </Empty>
      ) : activeTab === "graph" ? (
        <div className="graph-section">
          <p className="section-hint">同辈同行 · 拖动查看，点头像看资料</p>
          {!!search.trim() && (
            <section className="graph-search-results" aria-label="找到的家人">
              <p>找到 {filtered.length} 位家人，点头像看资料</p>
              <div>
                {filtered.map((person) => (
                  <button
                    type="button"
                    key={person.id}
                    onClick={(event) => pick(person.id, event.currentTarget)}
                  >
                    <Avatar person={person} />
                    <span>
                      <strong>{person.name}</strong>
                      <small>
                        {[
                          person.name !== person.originalName
                            ? person.originalName
                            : "",
                          person.city || "城市待补充",
                          labels[person.id],
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <FamilyGraph
            people={
              search
                ? people.map((p) => ({
                    ...p,
                    isDimmed: !filtered.some((f) => f.id === p.id),
                  }))
                : people
            }
            relations={data.relations}
            selfId={
              readOnly ? undefined : data.people.find((p) => p.isSelf)?.id
            }
            labels={labels}
            selectedId={selected || undefined}
            onSelect={pick}
          />
        </div>
      ) : activeTab === "map" ? (
        <div className="map-section">
          <p className="section-hint">看看大家在哪里 · 显示所在城市的位置</p>
          <Suspense fallback={<Loading label="正在打开地图…" />}>
            <PersonMap people={filtered} onSelect={pick} labels={labels} />
          </Suspense>
        </div>
      ) : (
        <div className="people-grid">
          {filtered.map((p) => (
            <button
              className="person-card"
              key={p.id}
              onClick={() => pick(p.id)}
            >
              <Avatar person={p} />
              <div className="person-card-copy">
                <h3>
                  {p.name}
                  {!readOnly && p.isSelf && (
                    <span className="self-tag">我</span>
                  )}
                </h3>
                {p.name !== p.originalName && (
                  <span className="original-name">{p.originalName}</span>
                )}
                <p>
                  {labels[p.id] ? `${labels[p.id]} · ` : ""}
                  {p.city || "城市待补充"}
                </p>
                <span>
                  {p.occupation ||
                    p.industry ||
                    p.school ||
                    p.status ||
                    "相聚有时，牵挂常在"}
                </span>
              </div>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}
      {current && (
        <PersonDetail
          floating={activeTab !== "list"}
          anchorElement={selectedAnchor}
          anchorSelector={
            activeTab === "graph"
              ? '.graph-person[aria-pressed="true"]'
              : undefined
          }
          key={`${activeTab}-${current.id}`}
          person={current}
          circleId={circleId!}
          readOnly={readOnly}
          remark={readOnly ? "" : data.remarks[current.id] || ""}
          kinship={
            !readOnly && data.people.some((p) => p.isSelf)
              ? relationshipFor(
                  data.people,
                  data.relations,
                  data.people.find((p) => p.isSelf)!.id,
                  current.id,
                )
              : undefined
          }
          onClose={() => dispatchView({ type: "close" })}
          onRemark={(remark) => onRemark?.(current.id, remark)}
        />
      )}
    </div>
  );
}
export function PersonDetail({
  person,
  circleId,
  remark,
  kinship,
  onClose,
  onRemark,
  floating = false,
  anchorElement,
  anchorSelector,
  readOnly = false,
}: {
  floating?: boolean;
  anchorElement?: HTMLElement | null;
  anchorSelector?: string;
  person: BrowsePerson;
  readOnly?: boolean;
  circleId: string;
  remark: string;
  kinship?: { label: string; path: string; missing?: string };
  onClose: () => void;
  onRemark: (remark: string) => void;
}) {
  const [photoOpen, setPhotoOpen] = useState(false);
  const visibleRemark = readOnly ? "" : remark;
  const [text, setText] = useState(visibleRemark),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(!floating);
  const save = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      const result = await rpc<{ remark: string }>("person.remark.update", {
        circleId,
        personId: person.id,
        remark: text,
      });
      onRemark(result.remark);
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const Panel = floating ? FloatingPanel : Modal;
  return (
    <>
      <Panel
        title={floating ? "近况与联系" : "熟悉的面孔"}
        onClose={onClose}
        busy={busy}
        {...(floating ? { anchorElement, anchorSelector } : {})}
      >
        <div className={`person-detail${floating ? " compact-detail" : ""}`}>
          <div className="detail-person-heading">
            {person.photoUrl ? (
              <button
                type="button"
                className="person-photo-button"
                aria-label={`放大${person.name}的照片`}
                onClick={() => setPhotoOpen(true)}
              >
                <Avatar person={person} large />
                <span>
                  <ZoomIn size={16} />
                  看大图
                </span>
              </button>
            ) : (
              <Avatar person={person} large />
            )}
            <div>
              <h2>
                {visibleRemark || person.name}
                {!readOnly && person.isSelf && (
                  <span className="self-tag">我</span>
                )}
              </h2>
              {visibleRemark && (
                <p className="muted original-name">{person.name}</p>
              )}
              {floating && (
                <p className="compact-location">
                  <MapPin size={13} />
                  {person.city || "城市待补充"}
                  {person.occupation || person.status
                    ? ` · ${person.occupation || person.status}`
                    : ""}
                </p>
              )}
            </div>
          </div>
          <ContactActions
            key={person.id}
            phone={person.phone}
            wechatId={person.wechatId}
          />
          {kinship && (
            <div className="kinship-note">
              <b>{kinship.label}</b>
              <span>{kinship.path}</span>
              {expanded && kinship.missing && <small>{kinship.missing}</small>}
            </div>
          )}
          {expanded && (
            <>
              <div className="detail-grid">
                <div>
                  <MapPin size={17} />
                  <span>所在城市</span>
                  <b>
                    {[person.country, person.province, person.city]
                      .filter(Boolean)
                      .filter(
                        (value, index, all) => all.indexOf(value) === index,
                      )
                      .join(" · ") || "尚未填写"}
                  </b>
                </div>
                <div>
                  <Cake size={17} />
                  <span>生日</span>
                  <b>
                    {person.birthday
                      ? `${person.birthday.calendar === "lunar" ? "农历" : "阳历"} ${person.birthday.year ? `${person.birthday.year}年` : ""}${person.birthday.leapMonth ? "闰" : ""}${person.birthday.month}月${person.birthday.day}日`
                      : "尚未填写"}
                  </b>
                </div>
                {[
                  [
                    "性别",
                    person.gender === "male"
                      ? "男"
                      : person.gender === "female"
                        ? "女"
                        : "",
                  ],
                  ["目前", person.status],
                  ["学校", person.school],
                  ["行业", person.industry],
                  ["职业", person.occupation],
                  ["电话", person.phone],
                  ["微信", person.wechatId],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <b>{value}</b>
                    </div>
                  ))}
              </div>
              {person.bio && <p className="bio">{person.bio}</p>}
            </>
          )}
          <Alert message={error} />
          {editing && !readOnly ? (
            <div className="remark-editor">
              <label>
                我对 TA 的备注
                <input
                  maxLength={60}
                  value={text}
                  disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="例如：大姑、小叔"
                />
              </label>
              <p className="hint">只对你自己显示，留空可恢复原名。</p>
              <div className="actions">
                <button
                  className="button secondary small-button"
                  disabled={busy}
                  onClick={() => {
                    setText(visibleRemark);
                    setError("");
                    setEditing(false);
                  }}
                >
                  取消
                </button>
                <button
                  className="button primary small-button"
                  disabled={busy}
                  onClick={save}
                >
                  {busy ? "保存中…" : "保存备注"}
                </button>
              </div>
            </div>
          ) : (
            <div className="detail-bottom-actions">
              {floating && (
                <button
                  className="text-button"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "收起资料" : "查看完整资料"}
                </button>
              )}
              {!readOnly &&
                (!person.isSelf ? (
                  <button
                    className="button secondary small-button"
                    onClick={() => {
                      setText(visibleRemark);
                      setError("");
                      setEditing(true);
                    }}
                  >
                    设置备注
                  </button>
                ) : (
                  <Link
                    className="button secondary small-button"
                    to="/me"
                    onClick={onClose}
                  >
                    修改我的资料
                  </Link>
                ))}
            </div>
          )}
        </div>
      </Panel>
      {photoOpen && person.photoUrl && (
        <Modal
          title={`${person.name}的照片`}
          onClose={() => setPhotoOpen(false)}
        >
          <img
            className="person-photo-preview"
            src={person.photoUrl}
            alt={`${person.name}的照片`}
          />
        </Modal>
      )}
    </>
  );
}

function Me() {
  const { user, circles, refresh, logout, notify, confirmSensitive } = useApp();
  const [profile, setProfile] = useState<UserProfile | null>(null),
    [photoUrl, setPhotoUrl] = useState<string | undefined>(),
    [loading, setLoading] = useState(true),
    [profileLoaded, setProfileLoaded] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [passwordOpen, setPasswordOpen] = useState(false),
    [devicesOpen, setDevicesOpen] = useState(false),
    [pending, setPending] = useState<ApplicationView[]>([]),
    [transfer, setTransfer] = useState<
      Array<{ circle: CircleView; ownerTransfer: any }>
    >([]),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const d = await rpc<{
        profile: (UserProfile & { hasPhoto?: boolean }) | null;
      }>("account.profile.get");
      if (version !== generation.current) return;
      setProfile(d.profile);
      setProfileLoaded(true);
      const [applications, photo, ...details] = await Promise.allSettled([
        rpc<{ applications: ApplicationView[] }>("join.mine"),
        d.profile?.hasPhoto
          ? rpc<{ url: string }>("photo.url").then((result) =>
              assetUrl(result.url),
            )
          : Promise.resolve(undefined),
        ...circles.map((c) =>
          rpc<{ ownerTransfer: any }>("circle.detail", { circleId: c.id }).then(
            (v) => ({ circle: c, ownerTransfer: v.ownerTransfer }),
          ),
        ),
      ] as const);
      if (version === generation.current) {
        setPending(
          applications.status === "fulfilled"
            ? applications.value.applications
            : [],
        );
        setPhotoUrl(photo.status === "fulfilled" ? photo.value : undefined);
        setTransfer(
          details.flatMap((result) =>
            result.status === "fulfilled" &&
            result.value.ownerTransfer?.isTarget
              ? [result.value]
              : [],
          ),
        );
        const failed = [applications, photo, ...details].filter(
          (result) => result.status === "rejected",
        );
        if (failed.length)
          setError(
            "个人资料已加载，部分照片、申请或管理通知暂未加载。请重试。",
          );
      }
    } catch (e) {
      if (version === generation.current) setError(errorText(e));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [circles]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const complete = !!(profile?.name && profile.city && profile.birthday);
  const managedCircles = circles.filter(
    (circle) => circle.role === "owner" || circle.role === "admin",
  );
  const action = async (fn: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!(await confirmSensitive(fn))) return;
      await refresh();
      notify(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page me-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">关于自己，也关于相连的人</p>
          <h1>
            我的<span className="title-dot">.</span>
          </h1>
        </div>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => action(logout, "已退出登录")}
        >
          <LogOut size={17} />
          退出登录
        </button>
      </header>
      <Alert message={error} />
      {error && !loading && (
        <button className="text-button" onClick={load}>
          重新加载我的资料
        </button>
      )}
      {loading ? (
        <Loading />
      ) : profileLoaded ? (
        <>
          <section className="profile-summary">
            <Avatar person={{ name: profile?.name || "我", photoUrl }} large />
            <div>
              <p className="eyebrow">我的资料</p>
              <h2>{profile?.name || "先介绍一下自己"}</h2>
              <p className="muted">
                {profile?.city
                  ? [profile.country, profile.city].join(" · ")
                  : "填写姓名、城市和生日，就可以和大家相聚。"}
              </p>
              <p className="small muted">
                一份个人资料，在加入的亲友录中使用。
              </p>
            </div>
            <button className="button primary" onClick={() => setEditing(true)}>
              <Camera size={23} />
              {complete ? "照片和资料" : "完善资料"}
            </button>
          </section>
          {managedCircles.length > 0 && (
            <section className="me-section">
              <div className="section-heading">
                <h2>
                  <Settings2 size={20} />
                  管理
                </h2>
              </div>
              <div className="management-list">
                {managedCircles.map((c) => (
                  <Link key={c.id} to={`/manage/${c.id}`}>
                    <span className="album-icon">
                      <Heart />
                    </span>
                    <div>
                      <b>{c.name}</b>
                      <span>{c.personCount} 位家人 · 成员、关系与邀请</span>
                    </div>
                    <ChevronRight size={18} />
                  </Link>
                ))}
              </div>
            </section>
          )}
          {!circles.length && (
            <p className="soft-note">
              打开家人的原邀请链接，确认已有资料或申请加入。
            </p>
          )}
          {transfer.map(({ circle: c, ownerTransfer: t }) => (
            <section className="transfer-notice" key={c.id}>
              <h3>接手「{c.name}」</h3>
              <p>确认后，你可以设置管理员并移交整本记录的管理。</p>
              <div className="actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    action(
                      () =>
                        rpc("circle.cancelOwnerTransfer", {
                          circleId: c.id,
                          transferId: t.id,
                        }),
                      "已婉拒",
                    )
                  }
                >
                  婉拒
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    action(
                      () =>
                        rpc("circle.acceptOwnerTransfer", {
                          circleId: c.id,
                          transferId: t.id,
                        }),
                      "已接手管理",
                    )
                  }
                >
                  确认接手
                </button>
              </div>
            </section>
          ))}
          {pending.length > 0 && (
            <details className="me-section" open={!circles.length}>
              <summary>
                加入申请 <span className="muted">{pending.length}</span>
              </summary>
              <div className="application-list">
                {pending.map((a) => (
                  <div key={a.id}>
                    <b>{a.circleName || "亲友录"}</b>
                    <span>
                      {(
                        {
                          pending: "等待管理员确认",
                          approved: "已通过",
                          rejected: "未通过",
                          expired: "邀请已失效",
                        } as Record<string, string>
                      )[a.status] || a.status}
                    </span>
                    {a.canEnter && (
                      <Link to={`/album/${a.circleId}`}>打开</Link>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          <section className="me-section account-section">
            <h2>
              <ShieldCheck size={20} />
              账号
            </h2>
            <div>
              <span>登录手机号</span>
              <b>{user.phone}</b>
            </div>
            <button
              className="text-button"
              onClick={() => setPasswordOpen(true)}
            >
              <KeyRound size={17} />
              修改登录密码
              <ChevronRight size={16} />
            </button>
            <button
              className="text-button"
              onClick={() => setDevicesOpen(true)}
            >
              <MonitorSmartphone size={17} />
              登录设备
              <ChevronRight size={16} />
            </button>
          </section>
          {circles.some((c) => c.role === "member" || c.role === "admin") && (
            <details className="me-section">
              <summary>退出亲友录</summary>
              <p className="hint">
                退出后取消成员权限，保留姓名与关系，联系方式等私人资料从本录清除。知道家庭名称仍可游客浏览。
              </p>
              {circles
                .filter((c) => c.role !== "owner")
                .map((c) => (
                  <div className="leave-row" key={c.id}>
                    <span>{c.name}</span>
                    <button
                      disabled={busy}
                      className="text-button danger"
                      onClick={() => {
                        if (
                          confirm(
                            `退出「${c.name}」？取消成员权限，联系方式等私人资料从本录清除。知道家庭名称仍可游客浏览。`,
                          )
                        )
                          action(
                            () => rpc("member.leave", { circleId: c.id }),
                            "已退出",
                          );
                      }}
                    >
                      退出
                    </button>
                  </div>
                ))}
            </details>
          )}
        </>
      ) : null}
      {editing && (
        <ProfileEditor
          profile={profile}
          photoUrl={photoUrl}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
            await refresh();
            notify("资料已保存");
          }}
        />
      )}
      {passwordOpen && (
        <PasswordDialog onClose={() => setPasswordOpen(false)} />
      )}
      {devicesOpen && <DevicesDialog onClose={() => setDevicesOpen(false)} />}
    </div>
  );
}
function ProfileEditor({
  profile,
  photoUrl,
  onClose,
  onSaved,
}: {
  profile: UserProfile | null;
  photoUrl?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { user } = useApp();
  const [draft, setDraft] = useState(() =>
      draftOf({ ...profile, phone: profile?.phone || user.phone }),
    ),
    [photo, setPhoto] = useState(""),
    [photoPreparing, setPhotoPreparing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  return (
    <Modal
      title="我的资料"
      onClose={onClose}
      busy={busy || photoPreparing}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (lock.current || photoPreparing) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await rpc("account.profile.update", { patch: patchOf(draft) });
            if (photo) {
              await uploadPhoto(photo);
              setPhoto("");
            }
            await onSaved();
          } catch (err) {
            setError(errorText(err));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <ProfileForm
          value={draft}
          onChange={setDraft}
          disabled={busy || photoPreparing}
          photoUrl={photoUrl}
          photoBase64={photo}
          onPhoto={setPhoto}
          onPhotoPreparing={setPhotoPreparing}
        />
        <Alert message={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || photoPreparing}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || photoPreparing}
            type="submit"
          >
            {photoPreparing ? "正在处理照片…" : busy ? "保存中…" : "保存资料"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ReauthenticateDialog({
  onClose,
  onVerified,
}: {
  onClose: () => void;
  onVerified: () => void;
}) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  return (
    <Modal title="确认是本人操作" onClose={onClose} busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await auth.reauthenticate(password);
            setPassword("");
            onVerified();
          } catch (err) {
            setPassword("");
            setError(errorText(err));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          此操作会调整家庭的管理或访问权限。请输入登录密码，确认后继续刚才的操作。
        </p>
        <label>
          登录密码
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <Alert message={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "确认中…" : "确认并继续"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DevicesDialog({ onClose }: { onClose: () => void }) {
  const { notify } = useApp();
  const [sessions, setSessions] = useState<LoginSession[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    lock = useRef(false);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await auth.sessions();
      if (version === generation.current) setSessions(result.sessions);
    } catch (err) {
      if (version === generation.current) setError(errorText(err));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const revoke = async (session?: LoginSession) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (session) {
        const result = await auth.revokeSession(session.id);
        if (result.currentRevoked) {
          window.dispatchEvent(new Event("session-expired"));
          return;
        }
        notify("该设备已退出登录");
      } else {
        const result = await auth.revokeOtherSessions();
        notify(
          result.revokedCount ? "其他设备已退出登录" : "没有其他已登录设备",
        );
      }
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const date = (value: number) =>
    new Date(value).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <Modal title="登录设备" onClose={onClose} busy={busy}>
      <p className="hint">
        查看已登录的设备。退出后，该设备需要重新输入密码登录。
      </p>
      <Alert message={error} />
      {error && !loading && (
        <button className="text-button" disabled={busy} onClick={load}>
          重新加载设备
        </button>
      )}
      {loading ? (
        <Loading label="正在查看登录设备…" />
      ) : (
        <div className="device-list">
          {sessions.map((session) => (
            <article className="device-row" key={session.id}>
              <div className="device-heading">
                <MonitorSmartphone size={20} />
                <h3>{session.deviceName || "浏览器"}</h3>
                {session.isCurrent && (
                  <span className="device-current">本机</span>
                )}
              </div>
              <dl>
                <div>
                  <dt>最近使用</dt>
                  <dd>{date(session.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt>登录到期</dt>
                  <dd>{date(session.expiresAt)}</dd>
                </div>
              </dl>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => revoke(session)}
              >
                {session.isCurrent ? "退出本机" : "退出此设备"}
              </button>
            </article>
          ))}
          {!sessions.length && !error && (
            <p className="soft-note">暂无登录设备，请重新登录。</p>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={
            busy || loading || !sessions.some((session) => !session.isCurrent)
          }
          onClick={() => revoke()}
        >
          退出其他设备
        </button>
        <button className="button primary" disabled={busy} onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { notify } = useApp();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="修改登录密码" onClose={onClose} busy={busy}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (next !== confirm) {
            setError("两次新密码不一致。");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await auth.password(current, next);
            notify("密码已修改，请妥善保存");
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,128}"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label>
            再输一次新密码
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        </fieldset>
        <p className="hint">
          至少 10 位，包含字母和数字。修改后其他设备会退出登录。
        </p>
        <Alert message={error} />
        <button className="button primary full" disabled={busy}>
          保存新密码
        </button>
      </form>
    </Modal>
  );
}
function Join() {
  const { token } = useParams();
  const { circles, refresh, notify } = useApp();
  const [preview, setPreview] = useState<{
      circle: CircleView;
      status: string;
    } | null>(null),
    [own, setOwn] = useState<ApplicationView | undefined>(),
    [profile, setProfile] = useState<UserProfile | null>(null),
    [matching, setMatching] = useState<OnboardingPreview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState(""),
    [editing, setEditing] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    setPreview(null);
    setOwn(undefined);
    setProfile(null);
    setMatching(null);
    try {
      const [p, a, u] = await Promise.all([
        rpc<{ circle: CircleView; status: string }>("invite.preview", {
          token,
        }),
        rpc<{ applications: ApplicationView[] }>("join.mine", {
          inviteToken: token,
        }),
        rpc<{ profile: UserProfile | null }>("account.profile.get"),
      ]);
      if (version === generation.current) {
        if (p.circle.type !== "family")
          throw new Error("这份邀请暂不可用，请联系家人获取新的邀请。");
        setPreview(p);
        setOwn(a.applications[0]);
        setProfile(u.profile);
        if (
          p.status === "active" &&
          a.applications[0]?.status !== "rejected" &&
          !a.applications[0]?.canEnter &&
          !circles.some((circle) => circle.id === p.circle.id)
        ) {
          const result = await onboarding.preview(token!);
          if (version === generation.current) setMatching(result);
        }
      }
    } catch (e) {
      if (version === generation.current) setError(errorText(e));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [token, circles]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const joined =
    circles.some((c) => c.id === preview?.circle.id) || own?.canEnter === true;
  const pending = own?.status === "pending";
  const pendingNeedsReview =
    pending &&
    matching &&
    matching.match.status !== "none" &&
    !(matching.match.status === "unique" && matching.match.confirmed);
  const matchedProfile = matching?.match.person?.profile;
  const canPrepare =
    matching?.match.status === "none" ||
    (matching?.match.status === "unique" && matching.match.confirmed);
  return (
    <div className="page join-page">
      <p className="eyebrow">有人为你留了一份牵挂</p>
      <h1>相聚在亲友录</h1>
      <Alert message={error} />
      {error && !loading && matching && (
        <button className="text-button" disabled={busy} onClick={load}>
          重新核对资料
        </button>
      )}
      {loading ? (
        <Loading />
      ) : preview ? (
        <section className="join-card">
          <span className="album-icon">
            <Heart />
          </span>
          <h2>{preview.circle.name}</h2>
          <p className="muted">家人录 · 记下彼此的关系与近况</p>
          {joined ? (
            <Link className="button primary" to={`/album/${preview.circle.id}`}>
              打开亲友录 <ChevronRight size={16} />
            </Link>
          ) : pending && !pendingNeedsReview ? (
            <div className="soft-note">
              申请已送达，等待管理员确认。
              <button
                className="text-button"
                disabled={busy}
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  setError("");
                  try {
                    await Promise.all([refresh(), load()]);
                  } catch (err) {
                    setError(errorText(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                刷新状态
              </button>
            </div>
          ) : preview.status !== "active" || own?.status === "rejected" ? (
            <p className="alert">此邀请已失效，请联系管理员发送新邀请。</p>
          ) : (
            <>
              {pending && (
                <p className="soft-note">
                  申请已送达。家人资料有更新，请重新核对，确认后继续等待管理员批准。
                </p>
              )}
              {!matching ? (
                <div className="soft-note">
                  资料核对暂未完成，请重新加载。
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={load}
                  >
                    重新加载
                  </button>
                </div>
              ) : matching.match.status === "unique" ? (
                <div className="soft-note">
                  <p className="eyebrow">找到家人为你添加的资料</p>
                  <b>{matchedProfile?.name}</b>
                  <p>登录手机号：{matching.loginPhone}</p>
                  <p>
                    {[
                      matchedProfile?.country,
                      matchedProfile?.province,
                      matchedProfile?.city,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {matchedProfile?.birthday && (
                    <p>
                      {matchedProfile.birthday.calendar === "lunar"
                        ? "农历"
                        : "阳历"}
                      {matchedProfile.birthday.year
                        ? ` ${matchedProfile.birthday.year}年`
                        : " "}
                      {matchedProfile.birthday.leapMonth ? "闰" : ""}
                      {matchedProfile.birthday.month}月
                      {matchedProfile.birthday.day}日
                    </p>
                  )}
                  <p>
                    {matching.match.confirmed
                      ? "已确认是本人。管理员批准后，沿用这份家人资料和亲属关系。"
                      : "请确认这是你本人，资料会带入，无需重新填写。加入仍需管理员确认。"}
                  </p>
                  {matchedProfile?.hasPhoto && (
                    <p className="hint">
                      未上传自己的照片时，批准后沿用家人添加的照片。
                    </p>
                  )}
                  {!matching.match.confirmed && matching.match.person && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={async () => {
                        if (busy || !matching.match.person) return;
                        setBusy(true);
                        setError("");
                        try {
                          await onboarding.importProfile({
                            inviteToken: token!,
                            personId: matching.match.person.id,
                            personUpdatedAt: matching.match.person.updatedAt,
                            profileVersion: matching.profileVersion,
                          });
                          await load();
                        } catch (err) {
                          setError(errorText(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? "正在确认…" : "这是我，使用这份资料"}
                    </button>
                  )}
                  <p className="hint">
                    如果不是你的资料，请联系管理员核对手机号。
                  </p>
                </div>
              ) : matching.match.status !== "none" ? (
                <div className="soft-note">
                  <p>
                    {matching.match.message ||
                      "手机号对应的家人资料需要核对，请联系管理员。"}
                  </p>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={load}
                  >
                    重新核对
                  </button>
                </div>
              ) : (
                <p>先填写个人资料，管理员确认后就能看到大家。</p>
              )}
              {canPrepare && !pending && (
                <>
                  <div className="join-profile">
                    <Avatar person={{ name: profile?.name || "我" }} />
                    <div>
                      <b>{profile?.name || "个人资料待填写"}</b>
                      <p>
                        {profile?.city || "城市待填写"} ·{" "}
                        {profile?.birthday ? "已填写生日" : "生日待填写"}
                      </p>
                    </div>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      {profile?.name && profile.city && profile.birthday
                        ? "检查资料"
                        : "完善资料"}
                    </button>
                  </div>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (busy) return;
                      setBusy(true);
                      setError("");
                      try {
                        if (!invitationCanApply(matching, profile))
                          throw new Error(
                            "请先确认本人资料，并填写姓名、城市和生日。",
                          );
                        await rpc("invite.apply", { token, note });
                        notify("申请已送达");
                        await Promise.all([refresh(), load()]);
                      } catch (err) {
                        setError(errorText(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label>
                      给管理员的话 · 选填
                      <textarea
                        value={note}
                        maxLength={300}
                        disabled={busy}
                        placeholder="让家人知道是你"
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </label>
                    <button
                      className="button primary full"
                      disabled={busy || !invitationCanApply(matching, profile)}
                    >
                      {busy ? "发送中…" : "申请加入"}
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </section>
      ) : (
        <button className="button secondary" onClick={load}>
          重新加载
        </button>
      )}
      {editing && (
        <ProfileEditor
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
        />
      )}
    </div>
  );
}
