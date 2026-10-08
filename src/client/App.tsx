import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, getLocalIdentities, switchLocalIdentity, userSafeError, type LocalIdentityList } from "./api";
import { HomeScreen, preferredName, rememberName } from "./HomeScreen";
import { BoardWorkspace, JoinBoard } from "./BoardScreen";
import type { BoardController } from "./sync/board";
import type { MeData } from "../shared/api";
import type { Retro } from "../shared/domain";
import { DraftStore } from "./sync/drafts";
import { Modal } from "./Modal";
import { Icon } from "./icons";

type IdentityState =
  | { status: "loading" }
  | { status: "ready"; data: MeData }
  | { status: "locked"; message: string };

function retroIdFromPath(path: string): string | undefined {
  const pathname = path.split("?", 1)[0] ?? "/";
  const match = pathname.match(/^\/retro\/([0-9a-f-]{36})\/?$/i);
  return match?.[1];
}

function navigate(path: string): void {
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect className="brand__mark-base" x="1" y="1" width="38" height="38" rx="12" />
      <rect className="brand__mark-note brand__mark-note--purple" x="6.5" y="13" width="15" height="18" rx="4" transform="rotate(-11 14 22)" />
      <rect className="brand__mark-note brand__mark-note--amber" x="17.5" y="9" width="15" height="20" rx="4" transform="rotate(10 25 19)" />
      <rect className="brand__mark-note brand__mark-note--green" x="12" y="14" width="17" height="20" rx="4" transform="rotate(-3 20.5 24)" />
      <path className="brand__mark-lines" d="M16.5 21.5h8 M16.5 25h5.5" />
      <path className="brand__mark-spark" d="M30 5.5 30.9 7.5 33 8.4 30.9 9.2 30 11.3 29.2 9.2 27.1 8.4 29.2 7.5Z" />
    </svg>
  );
}

function SiteHeader({ me, controllerRef, onHome }: { me: MeData; controllerRef: MutableRefObject<BoardController | undefined>; onHome: () => void }) {
  const [identities, setIdentities] = useState<LocalIdentityList>();
  const [identityError, setIdentityError] = useState<string>();
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!__RETROFLARE_LOCAL_DEVELOPMENT__) return;
    void getLocalIdentities().then(setIdentities).catch((error: unknown) => setIdentityError(userSafeError(error)));
  }, []);

  const selectIdentity = async (identity: string) => {
    if (!identity || switching) return;
    setSwitching(true);
    controllerRef.current?.close();
    controllerRef.current = undefined;
    try {
      await switchLocalIdentity(identity);
      window.location.reload();
    } catch (error) {
      setIdentityError(userSafeError(error));
      window.location.reload();
    }
  };

  const signOut = () => {
    controllerRef.current?.close();
    controllerRef.current = undefined;
    DraftStore.clearActor(window.location.origin, me.actorId);
    window.location.assign("/cdn-cgi/access/logout");
  };

  return (
    <header className="site-header">
      <button className="brand" type="button" onClick={onHome} aria-label="RetroFlare home">
        <BrandMark />
        <span className="brand__name">Retro<span>Flare</span></span>
      </button>
      <div className="site-header__right">
        {__RETROFLARE_LOCAL_DEVELOPMENT__ && <label className="local-switcher">
          <span className="local-switcher__label">Demo as</span>
          <select
            aria-label="Choose a local demo identity"
            value={identities?.currentIdentity ?? ""}
            disabled={!identities || switching}
            onChange={(event) => void selectIdentity(event.currentTarget.value)}
          >
            {identities ? identities.identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.displayName}</option>) : <option value="">Loading…</option>}
          </select>
          {identityError && <span className="visually-hidden" role="status">{identityError}</span>}
        </label>}
        <div className="user-chip" title={me.isAdministrator ? "Administrator" : undefined}>
          <span className="avatar avatar--header" aria-hidden="true">{me.displayName.trim().slice(0, 1).toUpperCase()}</span>
          <span className="user-chip__name">{me.displayName}</span>
          {me.isAdministrator && <span className="user-chip__admin">Admin</span>}
        </div>
        {!__RETROFLARE_LOCAL_DEVELOPMENT__ && <button className="header-signout" type="button" onClick={signOut}>Sign out</button>}
      </div>
    </header>
  );
}

export default function App() {
  const [identity, setIdentity] = useState<IdentityState>({ status: "loading" });
  const [path, setPath] = useState(`${window.location.pathname}${window.location.search}`);
  const [leavePath, setLeavePath] = useState<string>();
  const [leaveError, setLeaveError] = useState<string>();
  const [leaveWorking, setLeaveWorking] = useState(false);
  const controllerRef = useRef<BoardController | undefined>(undefined);
  const pathRef = useRef(path);

  useEffect(() => {
    let active = true;
    void api.me().then((data) => {
      if (active) setIdentity({ status: "ready", data });
    }).catch((error: unknown) => {
      if (active) setIdentity({ status: "locked", message: userSafeError(error) });
    });
    return () => { active = false; };
  }, []);

  const requestNavigation = useCallback(async (target: string) => {
    const controller = controllerRef.current;
    if (!controller || !retroIdFromPath(`${window.location.pathname}${window.location.search}`)) {
      navigate(target);
      return;
    }
    setLeaveError(undefined);
    try {
      const flushed = await controller.flushBeforeNavigation();
      if (flushed) {
        controller.close();
        controllerRef.current = undefined;
        navigate(target);
      } else {
        setLeavePath(target);
      }
    } catch {
      setLeavePath(target);
    }
  }, []);

  useEffect(() => { pathRef.current = path; }, [path]);

  useEffect(() => {
    const update = () => {
      const target = `${window.location.pathname}${window.location.search}`;
      const previous = pathRef.current;
      if (controllerRef.current && retroIdFromPath(previous) && retroIdFromPath(target) !== retroIdFromPath(previous)) {
        window.history.pushState({}, "", previous);
        setPath(previous);
        void requestNavigation(target);
        return;
      }
      pathRef.current = target;
      setPath(target);
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [requestNavigation]);

  const setController = useCallback((controller: BoardController | undefined) => {
    controllerRef.current = controller;
  }, []);
  const openHome = useCallback(() => {
    controllerRef.current?.close();
    controllerRef.current = undefined;
    navigate("/");
  }, []);
  const openRetro = useCallback((id: string) => navigate(`/retro/${id}`), []);

  if (identity.status === "loading") return <main className="app-loading"><span className="spinner" /><span>Opening RetroFlare…</span></main>;
  if (identity.status === "locked") return <main className="locked-page">
    <div className="brand brand--static"><BrandMark /><span className="brand__name">Retro<span>Flare</span></span></div>
    <section className="locked-card" role="alert">
      <span className="locked-card__mark" aria-hidden="true"><Icon name="trendUp" size={18} /></span>
      <h1>We couldn’t open your team space.</h1>
      <p>{identity.message}</p>
      <button className="button button--secondary" type="button" onClick={() => window.location.reload()}>Try again</button>
    </section>
    <p className="locked-footnote">If you believe you should have access, ask your team administrator.</p>
  </main>;

  const me = identity.data;
  const retroId = retroIdFromPath(path);
  return <div className={`app-shell ${retroId ? "app-shell--board" : ""}`}>
    <SiteHeader me={me} controllerRef={controllerRef} onHome={() => void requestNavigation("/")} />
    {retroId ? <BoardRoute
      key={retroId}
      id={retroId}
      me={me}
      onHome={openHome}
      onController={setController}
    /> : <HomeScreen
      me={me}
      onOpen={openRetro}
      onCreated={(retro, name) => {
        rememberName(me.actorId, name);
        navigate(`/retro/${retro.id}`);
      }}
    />}
    <Modal open={Boolean(leavePath)} onClose={() => { setLeavePath(undefined); setLeaveError(undefined); }} title="Leave this board?" description="We’ll try to sync your changes first. If the connection is away, you can keep the draft on this device and come back within 24 hours.">
      {leaveError && <p className="form-error" role="alert">{leaveError}</p>}
      <div className="modal__actions modal__actions--spread">
        <button className="button button--quiet" type="button" onClick={() => { setLeavePath(undefined); setLeaveError(undefined); }}>Stay here</button>
        <button className="button button--secondary" type="button" disabled={leaveWorking} onClick={() => {
          const target = leavePath;
          const controller = controllerRef.current;
          if (!target || !controller) return;
          setLeaveWorking(true);
          void controller.flushBeforeNavigation().then((saved) => {
            if (!saved) {
              setLeaveError("Some notes still haven’t been saved. You can retry or keep them on this device.");
              return;
            }
            controller.close();
            controllerRef.current = undefined;
            setLeavePath(undefined);
            navigate(target);
          }).catch((error: unknown) => setLeaveError(userSafeError(error))).finally(() => setLeaveWorking(false));
        }}>{leaveWorking ? "Saving…" : "Retry saving"}</button>
        <button className="button button--danger-quiet" type="button" onClick={() => {
          const target = leavePath;
          if (!target) return;
          controllerRef.current?.retainDrafts();
          controllerRef.current?.close();
          controllerRef.current = undefined;
          setLeavePath(undefined);
          navigate(target);
        }}>Keep draft &amp; leave</button>
      </div>
    </Modal>
  </div>;
}

function BoardRoute({ id, me, onHome, onController }: {
  id: string;
  me: MeData;
  onHome: () => void;
  onController: (controller: BoardController | undefined) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; retro: Retro }
    | { status: "join"; retro: Retro }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    void api.retro(id).then(async (retro) => {
      if (!active) return;
      if (retro.status !== "closed" && !retro.participants[me.actorId]) {
        setState({ status: "join", retro });
        return;
      }
      if (retro.status !== "closed") {
        const preferred = preferredName(me.actorId, retro.participants[me.actorId]?.displayName ?? me.displayName);
        const current = retro.participants[me.actorId]?.displayName;
        if (preferred.trim() && preferred.trim() !== current) {
          await api.joinRetro(id, preferred.trim());
          retro = await api.retro(id);
        }
      }
      if (active) setState({ status: "ready", retro });
    }).catch((error: unknown) => {
      if (active) setState({ status: "error", message: userSafeError(error) });
    });
    return () => { active = false; };
  }, [id, me.actorId, me.displayName]);

  if (state.status === "loading") return <main className="board-loading"><span className="spinner" /> Opening your board…</main>;
  if (state.status === "error") return <main className="route-error">
    <button className="back-link" type="button" onClick={onHome}><Icon name="arrowLeft" size={15} /> All retros</button>
    <section className="route-error__card"><span aria-hidden="true"><Icon name="circle" size={16} /></span><h1>This retro isn’t available.</h1><p>{state.message}</p><button className="button button--secondary" type="button" onClick={onHome}>Back to all retros</button></section>
  </main>;
  if (state.status === "join") return <JoinBoard retro={state.retro} me={me} onJoined={(retro) => setState({ status: "ready", retro })} onHome={onHome} />;
  return <BoardWorkspace retro={state.retro} me={me} onHome={onHome} onController={onController} />;
}
