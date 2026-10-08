import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, parseBackupFile, userSafeError } from "./api";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import type { MeData } from "../shared/api";
import type { ImportPreviewData } from "../shared/backup";
import type { Retro, RetroSummary } from "../shared/domain";
import type { ImportResult } from "../shared/backup";
import { LIMITS } from "../shared/constants";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "./storage-keys";

function preferredName(actorId: string, fallback: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}name:${actorId}`)
      ?? localStorage.getItem(`${LEGACY_STORAGE_PREFIX}name:${actorId}`)
      ?? fallback;
  } catch {
    return fallback;
  }
}

function rememberName(actorId: string, name: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}name:${actorId}`, name);
  } catch {
    // A blocked storage preference does not block joining or creating a board.
  }
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];

function updatedLabel(value: string, now: number): string {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Updated just now";
  const [unit, size] = RELATIVE_STEPS.find(([, step]) => elapsed >= step) ?? RELATIVE_STEPS[2];
  if (unit === "day" && elapsed >= 7 * size) return `Updated ${dateLabel(value)}`;
  return `Updated ${new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.floor(elapsed / size), unit)}`;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function allOpenRetros(): Promise<RetroSummary[]> {
  const retros: RetroSummary[] = [];
  for (const status of ["open", "closing"] as const) {
    let cursor: string | undefined;
    do {
      const page = await api.retros(status, cursor);
      retros.push(...page.retros);
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
  }
  return retros.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function downloadAllHistory(): void {
  const link = document.createElement("a");
  link.href = "/api/export";
  link.download = `retroflare-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function SummaryCard({ summary, onOpen }: { summary: RetroSummary; onOpen: () => void }) {
  const closed = summary.status === "closed";
  return (
    <button className={`retro-summary ${closed ? "retro-summary--closed" : ""}`} type="button" onClick={onOpen}>
      <span className="retro-summary__mark" aria-hidden="true"><Icon name={closed ? "check" : "trendUp"} size={16} /></span>
      <span className="retro-summary__body">
        <span className="retro-summary__title">{summary.title}</span>
        <span className="retro-summary__meta">
          {dateLabel(summary.closedAt ?? summary.createdAt)}
          <span className="meta-dot" aria-hidden="true">·</span>
          {plural(summary.cardCount, "card", "cards")}
          <span className="meta-dot" aria-hidden="true">·</span>
          {plural(summary.participantCount, "person", "people")}
          <span className="meta-dot" aria-hidden="true">·</span>
          Hosted by {summary.captainDisplayName}
        </span>
      </span>
      <span className={`status-tag ${summary.status === "closing" ? "status-tag--closing" : closed ? "status-tag--quiet" : "status-tag--open"}`}>
        {summary.status === "closing" ? "Finishing" : closed ? "Complete" : "In progress"}
      </span>
      <span className="retro-summary__arrow" aria-hidden="true"><Icon name="arrowRight" size={15} /></span>
    </button>
  );
}

function OngoingTile({ summary, now, onOpen }: { summary: RetroSummary; now: number; onOpen: () => void }) {
  const closing = summary.status === "closing";
  return (
    <button className="retro-tile" type="button" onClick={onOpen}>
      <span className="retro-tile__stripe" aria-hidden="true"><span /><span /><span /></span>
      <span className="retro-tile__top">
        <span className={`status-tag ${closing ? "status-tag--closing" : "status-tag--open"}`}>{closing ? "Finishing" : "In progress"}</span>
        <span className="retro-tile__updated">{updatedLabel(summary.updatedAt, now)}</span>
      </span>
      <span className="retro-tile__title">{summary.title}</span>
      <span className="retro-tile__stats">
        <span><Icon name="users" size={14} />{plural(summary.participantCount, "person", "people")}</span>
        <span><Icon name="layers" size={14} />{plural(summary.cardCount, "card", "cards")}</span>
      </span>
      <span className="retro-tile__footer">
        <span className="retro-tile__host">
          <span className="avatar avatar--tiny" aria-hidden="true">{initials(summary.captainDisplayName)}</span>
          <span>Hosted by {summary.captainDisplayName}</span>
        </span>
        <span className="retro-tile__open">Open <Icon name="arrowRight" size={14} /></span>
      </span>
    </button>
  );
}

/* A decorative, static preview of a live board: the product explains itself. */
function HeroPreview() {
  return (
    <div className="hero-preview" aria-hidden="true">
      <div className="hero-preview__window">
        <div className="hero-preview__bar">
          <span className="hero-preview__dots"><i /><i /><i /></span>
          <span className="hero-preview__title">Sprint 42 retro</span>
          <span className="hero-preview__people">
            <span className="hero-preview__faces"><i className="tone-a">PK</i><i className="tone-b">SM</i><i className="tone-c">JL</i></span>
            3 online
          </span>
        </div>
        <div className="hero-preview__lanes">
          <div className="hero-lane hero-lane--green">
            <span className="hero-lane__head"><Icon name="trendUp" size={12} />Went well</span>
            <span className="hero-card">
              <span className="hero-card__text">Pairing on the release made it painless</span>
              <span className="hero-card__reaction">🎉 4</span>
            </span>
            <span className="hero-card hero-card--short"><span className="hero-card__text">Fewer late-night pages</span></span>
          </div>
          <div className="hero-lane hero-lane--amber">
            <span className="hero-lane__head"><Icon name="circle" size={12} />Could improve</span>
            <span className="hero-card">
              <span className="hero-card__text">Reviews waited too long</span>
              <span className="hero-card__typing"><i /><i /><i /></span>
            </span>
          </div>
          <div className="hero-lane hero-lane--purple">
            <span className="hero-lane__head"><Icon name="star" size={12} />Shoutouts</span>
            <span className="hero-card">
              <span className="hero-card__text">Priya for the demo rescue</span>
              <span className="hero-card__reaction">❤️ 6</span>
            </span>
          </div>
        </div>
      </div>
      <span className="hero-preview__cursor"><Icon name="cursor" size={16} /><span>Sam</span></span>
      <span className="hero-preview__burst">🙌</span>
    </div>
  );
}

export function HomeScreen({
  me,
  onOpen,
  onCreated
}: {
  me: MeData;
  onOpen: (id: string) => void;
  onCreated: (retro: Retro, name: string) => void;
}) {
  const [ongoing, setOngoing] = useState<RetroSummary[]>([]);
  const [completed, setCompleted] = useState<RetroSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [startOpen, setStartOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [title, setTitle] = useState("");
  const [name, setName] = useState(() => preferredName(me.actorId, me.displayName));
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [openRetros, closedPage] = await Promise.all([allOpenRetros(), api.retros("closed")]);
      setOngoing(openRetros);
      setCompleted(closedPage.retros);
      setCursor(closedPage.nextCursor);
      setHasMore(closedPage.hasMore);
      setNow(Date.now());
    } catch (loadError) {
      setError(userSafeError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const loadNextPage = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await api.retros("closed", cursor);
      setCompleted((current) => [...current, ...page.retros]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (loadError) {
      setError(userSafeError(loadError));
    } finally {
      setLoadingMore(false);
    }
  };

  const createRetro = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      const created = await api.createRetro({ title, displayName: name });
      rememberName(me.actorId, name.trim());
      onCreated(created.retro, name.trim());
    } catch (createError) {
      setError(userSafeError(createError));
    } finally {
      setCreating(false);
    }
  };

  const exportAll = async () => {
    setExporting(true);
    setError(undefined);
    try {
      downloadAllHistory();
    } catch (exportError) {
      setError(userSafeError(exportError));
    } finally {
      setExporting(false);
    }
  };

  const openStart = () => {
    setName(preferredName(me.actorId, me.displayName));
    setTitle("");
    setError(undefined);
    setStartOpen(true);
  };

  return (
    <main className="home-content">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__copy">
          <p className="eyebrow">Team retrospectives</p>
          <h1 id="home-title">
            <span className="home-hero__line">Reflect together.</span>{" "}
            <span className="home-hero__line"><span className="home-hero__mark">Improve</span> on purpose.</span>
          </h1>
          <p className="home-hero__intro">A calm, real-time space to celebrate what went well, untangle what got in the way, and turn the conversation into next steps.</p>
          <div className="home-hero__actions">
            <button className="button button--primary button--large" type="button" onClick={openStart}>
              <Icon name="plus" size={18} /> Start a retro
            </button>
            <p className="home-hero__hint"><Icon name="link" size={14} />Share the board link — your team joins in seconds.</p>
          </div>
        </div>
        <HeroPreview />
      </section>

      {error && <div className="notice notice--error" role="alert">{error}</div>}

      <section className="home-section" aria-labelledby="ongoing-heading">
        <div className="section-heading">
          <div className="section-heading__copy">
            <div className="section-heading__title">
              <h2 id="ongoing-heading">Ongoing</h2>
              {!loading && ongoing.length > 0 && <span className="section-count">{ongoing.length}</span>}
            </div>
            <p className="section-heading__description">Jump back in — every note saves as it’s typed.</p>
          </div>
        </div>
        {loading ? (
          <div className="loading-lines loading-lines--tiles" aria-label="Loading retrospectives"><span /><span /><span /></div>
        ) : ongoing.length > 0 ? (
          <div className="tile-grid">
            {ongoing.map((summary) => <OngoingTile key={summary.id} summary={summary} now={now} onOpen={() => onOpen(summary.id)} />)}
            <button className="retro-tile retro-tile--new" type="button" onClick={openStart}>
              <span className="retro-tile__plus" aria-hidden="true"><Icon name="plus" size={18} /></span>
              <span className="retro-tile__new-title">New retro</span>
              <span className="retro-tile__new-copy">Gather the team for another round.</span>
            </button>
          </div>
        ) : (
          <div className="empty-state empty-state--ongoing">
            <span className="empty-state__illustration" aria-hidden="true">
              <span className="note note--a" /><span className="note note--b" /><span className="note note--c" />
            </span>
            <div>
              <h3>Nothing in progress</h3>
              <p>Start a retro when the team is ready. Everyone writes at once, and every note saves as it’s typed.</p>
            </div>
            <button className="button button--secondary" type="button" onClick={openStart}>Start your first retro</button>
          </div>
        )}
      </section>

      <section className="home-section home-section--history" aria-labelledby="history-heading">
        <div className="section-heading">
          <div className="section-heading__copy">
            <div className="section-heading__title">
              <h2 id="history-heading">Completed</h2>
              {!loading && completed.length > 0 && <span className="section-count">{completed.length}{hasMore ? "+" : ""}</span>}
            </div>
            <p className="section-heading__description">Every finished retro, ready whenever you want to look back.</p>
          </div>
          <div className="section-heading__actions">
            <button className="section-action" type="button" onClick={() => void exportAll()} disabled={exporting}>
              <Icon name="download" size={15} />{exporting ? "Preparing backup…" : "Export all"}
            </button>
            {me.isAdministrator && <button className="section-action" type="button" onClick={() => setImportOpen(true)}>
              <Icon name="upload" size={15} />Import backup
            </button>}
          </div>
        </div>
        {loading ? (
          <div className="loading-lines loading-lines--short" aria-label="Loading history"><span /><span /></div>
        ) : completed.length > 0 ? (
          <>
            <div className="summary-list summary-list--history">
              {completed.map((summary) => <SummaryCard key={summary.id} summary={summary} onOpen={() => onOpen(summary.id)} />)}
            </div>
            {hasMore && <button className="button button--quiet load-more" type="button" disabled={loadingMore} onClick={() => void loadNextPage()}>
              {loadingMore ? "Loading…" : "Show older retros"}
            </button>}
          </>
        ) : (
          <div className="history-empty">
            <span className="history-empty__mark" aria-hidden="true"><Icon name="check" size={15} /></span>
            <p>Finished retros settle here, ready whenever you want to look back.</p>
          </div>
        )}
      </section>

      <footer className="home-footer">
        <span className="home-footer__brand">Reflect together. Improve on purpose.</span>
        <span>RetroFlare <span aria-hidden="true">·</span> Team space</span>
      </footer>

      <Modal open={startOpen} onClose={() => setStartOpen(false)} title="Start a retro" description="Give this conversation a name. You can invite your team by sharing the board." >
        <form className="form-stack" onSubmit={(event) => void createRetro(event)}>
          <label className="field-label" htmlFor="retro-title">Retro title</label>
          <input
            id="retro-title"
            className="text-input"
            autoFocus
            maxLength={LIMITS.retroTitleCharacters}
            required
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="e.g. October team retro"
          />
          <label className="field-label" htmlFor="retro-display-name">Your display name</label>
          <input
            id="retro-display-name"
            className="text-input"
            maxLength={LIMITS.displayNameCharacters}
            required
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoComplete="name"
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal__actions">
            <button className="button button--quiet" type="button" onClick={() => setStartOpen(false)}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={creating || !title.trim() || !name.trim()}>
              {creating ? "Creating…" : "Create retro"}
            </button>
          </div>
        </form>
      </Modal>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => void load()} />
    </main>
  );
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [backup, setBackup] = useState<Awaited<ReturnType<typeof parseBackupFile>>>();
  const [preview, setPreview] = useState<ImportPreviewData>();
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const closeDialog = () => {
    setBackup(undefined);
    setPreview(undefined);
    setResult(undefined);
    setError(undefined);
    setConfirmed(false);
    onClose();
  };

  const selectFile = async (file?: File) => {
    setPreview(undefined);
    setResult(undefined);
    setConfirmed(false);
    setError(undefined);
    if (!file) {
      setBackup(undefined);
      return;
    }
    try {
      setBackup(await parseBackupFile(file));
    } catch (fileError) {
      setBackup(undefined);
      setError(fileError instanceof Error && fileError.name === "ZodError" ? "This backup doesn’t match the RetroFlare format." : userSafeError(fileError));
    }
  };

  const getPreview = async () => {
    if (!backup) return;
    setWorking(true);
    setError(undefined);
    try {
      setPreview(await api.importPreview(backup));
    } catch (previewError) {
      setError(userSafeError(previewError));
    } finally {
      setWorking(false);
    }
  };

  const confirmImport = async () => {
    if (!backup || !preview || !confirmed) return;
    setWorking(true);
    setError(undefined);
    try {
      const imported = await api.importBackup({
        previewId: preview.previewId,
        confirmation: "append-only-import",
        backup
      });
      setResult(imported);
      onImported();
    } catch (importError) {
      setError(userSafeError(importError));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal open={open} onClose={closeDialog} title="Import history" description="Preview a backup before appending completed retros to this team space." size="wide">
      <div className="form-stack">
        <label className="field-label" htmlFor="backup-file">Backup JSON file</label>
        <input id="backup-file" className="file-input" type="file" accept="application/json,.json" onChange={(event) => void selectFile(event.currentTarget.files?.[0])} />
        <p className="field-hint">Up to 10 MiB. Existing history is never overwritten.</p>
        {backup && <p className="file-selected"><span aria-hidden="true"><Icon name="check" size={13} /></span> {backup.retros.length} {backup.retros.length === 1 ? "retro" : "retros"} ready to preview</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {preview && <div className="import-report" aria-live="polite">
          <div className="import-report__summary">
            <strong>{preview.report.createCount} to add</strong>
            <span>{preview.report.skipIdenticalCount} already present</span>
            <span>{preview.report.conflictCount} ID conflicts</span>
            <span>{preview.report.batchCount} {preview.report.batchCount === 1 ? "batch" : "batches"} · up to {LIMITS.importBatchBoards} each</span>
          </div>
          {preview.report.conflictCount > 0 && <p className="field-hint">Existing conflicting IDs are left untouched. Other retros in the same batch can still be added.</p>}
          <div className="import-report__items">
            {preview.report.items.map((item) => <div className="import-report__item" key={item.retroId}>
              <span>{item.title}</span>
              <span className="import-report__status">
                <span className="batch-number">Batch {item.batchNumber}</span>
                <span className={`import-disposition import-disposition--${item.disposition}`}>
                {item.disposition === "create" ? "Will add" : item.disposition === "skip-identical" ? "Already present" : "Conflict · skipped"}
                </span>
              </span>
            </div>)}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
            <span>I understand this adds completed history only and does not overwrite existing retros.</span>
          </label>
        </div>}
        {result && <div className={result.remainingBatchCount > 0 ? "notice notice--warning" : "notice notice--success"} role="status">
          <strong>{result.completedBatchCount} of {result.completedBatchCount + result.remainingBatchCount} batches completed.</strong>
          {result.remainingBatchCount > 0 && <span> Some batches need another attempt; already-added history will be safely skipped on retry.</span>}
          {result.remainingBatchCount === 0 && <span> History is ready in the completed list.</span>}
        </div>}
        {result && <div className="batch-progress" aria-label="Import batch results">
          {result.batches.map((batch) => <span className={`batch-progress__item batch-progress__item--${batch.status}`} key={batch.batchNumber}>
            <span className="batch-progress__dot" /> Batch {batch.batchNumber}: {batch.status === "applied" ? `added${batch.conflictingRetroIds.length ? ` · ${batch.conflictingRetroIds.length} ID conflict${batch.conflictingRetroIds.length === 1 ? "" : "s"} left untouched` : ""}` : batch.status === "already-applied" ? (batch.conflictingRetroIds.length ? `${batch.conflictingRetroIds.length} ID conflict${batch.conflictingRetroIds.length === 1 ? "" : "s"} left untouched` : "already added") : "needs retry"}
          </span>)}
        </div>}
        <div className="modal__actions modal__actions--spread">
          <button className="button button--quiet" type="button" onClick={closeDialog}>Close</button>
          {!preview && <button className="button button--primary" type="button" disabled={!backup || working} onClick={() => void getPreview()}>
            {working ? "Checking backup…" : "Preview import"}
          </button>}
          {preview && !result && <button className="button button--primary" type="button" disabled={!confirmed || working} onClick={() => void confirmImport()}>
            {working ? "Importing…" : "Add completed history"}
          </button>}
          {result && result.remainingBatchCount > 0 && <button className="button button--secondary" type="button" disabled={working} onClick={() => void confirmImport()}>
            {working ? "Retrying…" : "Retry remaining batches"}
          </button>}
          {result && result.remainingBatchCount === 0 && <button className="button button--primary" type="button" onClick={closeDialog}>Done</button>}
        </div>
      </div>
    </Modal>
  );
}

export { preferredName, rememberName };
