import { GiphyFetch } from "@giphy/js-fetch-api";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LIMITS } from "../shared/constants";
import { GiphyMediaSchema, type GiphyMedia } from "../shared/protocol";
import { Modal } from "./Modal";

const GIPHY_API_KEY = import.meta.env.VITE_GIPHY_API_KEY?.trim();
const PAGE_SIZE = 20;

type GiphyCandidate = {
  id: string | number;
  title?: string;
  images?: {
    fixed_height?: { url?: string };
    fixed_width?: { url?: string };
    original?: { url?: string };
  };
};

type GiphyPickerResultState = {
  queryKey: string;
  results: GiphyCandidate[];
  offset: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
};

function mediaFromGif(gif: GiphyCandidate): GiphyMedia | undefined {
  const imageUrl = gif.images?.fixed_height?.url ?? gif.images?.fixed_width?.url ?? gif.images?.original?.url;
  if (!imageUrl) return undefined;
  const title = gif.title?.trim() || "A GIPHY reaction";
  const parsed = GiphyMediaSchema.safeParse({
    id: String(gif.id),
    imageUrl,
    title: title.slice(0, LIMITS.giphyTitleCharacters)
  });
  return parsed.success ? parsed.data : undefined;
}

export function GiphyPicker({
  open,
  onClose,
  onSelect
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (media: GiphyMedia) => boolean;
}) {
  const giphyFetch = useMemo(() => GIPHY_API_KEY ? new GiphyFetch(GIPHY_API_KEY) : undefined, []);
  const [mediaType, setMediaType] = useState<"gifs" | "stickers">("gifs");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchGeneration, setSearchGeneration] = useState(0);
  const [resultState, setResultState] = useState<GiphyPickerResultState>({
    queryKey: "",
    results: [],
    offset: 0,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: ""
  });
  const requestGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const queryKey = `${open ? "open" : "closed"}:${mediaType}:${searchTerm}:${searchGeneration}`;
  const hasCurrentResults = resultState.queryKey === queryKey;
  const results = hasCurrentResults ? resultState.results : [];
  const offset = hasCurrentResults ? resultState.offset : 0;
  const hasMore = hasCurrentResults && resultState.hasMore;
  const loading = open && Boolean(giphyFetch) && (!hasCurrentResults || resultState.loading);
  const loadingMore = hasCurrentResults && resultState.loadingMore;
  const fetchError = hasCurrentResults ? resultState.error : "";

  const fetchGifs = useCallback((pageOffset: number) => {
    if (!giphyFetch) return Promise.reject(new Error("GIPHY is not configured."));
    const options = { offset: pageOffset, limit: PAGE_SIZE, rating: "g" as const, type: mediaType };
    return searchTerm
      ? giphyFetch.search(searchTerm, options)
      : giphyFetch.trending(options);
  }, [giphyFetch, mediaType, searchTerm]);

  useEffect(() => {
    if (!open || !giphyFetch) return;
    const generation = ++requestGeneration.current;
    loadingMoreRef.current = false;
    void fetchGifs(0).then((response) => {
      if (requestGeneration.current !== generation) return;
      const page = response.data as GiphyCandidate[];
      setResultState({
        queryKey,
        results: page,
        offset: page.length,
        hasMore: response.pagination.total_count > page.length,
        loading: false,
        loadingMore: false,
        error: ""
      });
    }).catch(() => {
      if (requestGeneration.current === generation) {
        setResultState({
          queryKey,
          results: [],
          offset: 0,
          hasMore: false,
          loading: false,
          loadingMore: false,
          error: "GIPHY results couldn’t be loaded. Please try again."
        });
      }
    });
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [open, giphyFetch, fetchGifs, queryKey]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearchTerm(searchInput.trim());
    setSearchGeneration((generation) => generation + 1);
  };

  const loadMore = async () => {
    if (!giphyFetch || !hasMore || loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const generation = requestGeneration.current;
    const currentQueryKey = queryKey;
    setResultState((current) => current.queryKey === currentQueryKey
      ? { ...current, loadingMore: true, error: "" }
      : current);
    try {
      const response = await fetchGifs(offset);
      if (requestGeneration.current !== generation) return;
      const page = response.data as GiphyCandidate[];
      setResultState((current) => {
        if (current.queryKey !== currentQueryKey) return current;
        const nextOffset = current.offset + page.length;
        return {
          ...current,
          results: [...current.results, ...page],
          offset: nextOffset,
          hasMore: response.pagination.total_count > nextOffset
        };
      });
    } catch {
      if (requestGeneration.current === generation) {
        setResultState((current) => current.queryKey === currentQueryKey
          ? { ...current, error: "More GIPHY results couldn’t be loaded. Please try again." }
          : current);
      }
    } finally {
      if (requestGeneration.current === generation) {
        loadingMoreRef.current = false;
        setResultState((current) => current.queryKey === currentQueryKey
          ? { ...current, loadingMore: false }
          : current);
      }
    }
  };

  const selectMedia = (media: GiphyMedia) => {
    if (onSelect(media)) onClose();
    else setResultState((current) => current.queryKey === queryKey
      ? { ...current, error: "Your board isn’t connected. Reconnect, then try sharing again." }
      : current);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pick a GIF or sticker"
      description="Choose a reaction to send floating across this retro. It disappears after a few seconds."
      size="wide"
    >
      {!giphyFetch ? (
        <div className="giphy-picker__unconfigured" role="status">
          <strong>GIPHY isn’t configured for this build.</strong>
          <span>Set <code>VITE_GIPHY_API_KEY</code> before building to enable GIF search.</span>
        </div>
      ) : (
        <>
          <form className="giphy-picker__search" onSubmit={submitSearch}>
            <label className="field-label" htmlFor="giphy-search">Search GIFs and stickers</label>
            <div className="giphy-picker__search-row">
              <input
                id="giphy-search"
                className="text-input"
                type="search"
                value={searchInput}
                placeholder="Try “celebrate” or “thanks”"
                onChange={(event) => setSearchInput(event.currentTarget.value)}
              />
              <button className="button button--primary" type="submit">Search</button>
            </div>
          </form>

          <div className="giphy-picker__tabs" role="tablist" aria-label="GIPHY media type">
            {(["gifs", "stickers"] as const).map((type) => (
              <button
                key={type}
                className={`giphy-picker__tab ${mediaType === type ? "giphy-picker__tab--selected" : ""}`}
                type="button"
                role="tab"
                aria-selected={mediaType === type}
                onClick={() => setMediaType(type)}
              >
                {type === "gifs" ? "GIFs" : "Stickers"}
              </button>
            ))}
          </div>

          {fetchError && <p className="form-error" role="alert">{fetchError}</p>}
          <div className="giphy-picker__results" role="region" aria-label="GIPHY search results">
            {loading && results.length === 0 && <p className="field-hint" role="status">Loading GIPHY results…</p>}
            {!loading && results.length === 0 && !fetchError && <p className="field-hint">No results found. Try another search.</p>}
            <div className="giphy-picker__grid">
              {results.map((gif) => {
                const media = mediaFromGif(gif);
                if (!media) return null;
                return <button
                  key={`${media.id}-${media.imageUrl}`}
                  className="giphy-picker__result"
                  type="button"
                  data-giphy-id={media.id}
                  aria-label={`Share ${media.title}`}
                  title={media.title}
                  onClick={() => selectMedia(media)}
                >
                  <img src={media.imageUrl} alt="" loading="lazy" decoding="async" />
                </button>;
              })}
            </div>
            {loadingMore && <p className="field-hint" role="status">Loading more…</p>}
            {hasMore && <button className="button button--quiet giphy-picker__load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>}
          </div>
          <p className="giphy-picker__attribution"><a href="https://giphy.com" target="_blank" rel="noreferrer">Powered by GIPHY</a></p>
        </>
      )}
    </Modal>
  );
}
