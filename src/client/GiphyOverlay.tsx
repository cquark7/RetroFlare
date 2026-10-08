import { LIMITS } from "../shared/constants";
import type { GiphySharedMessage } from "../shared/protocol";

export function GiphyOverlay({ shares }: { shares: GiphySharedMessage[] }) {
  if (shares.length === 0) return null;
  return (
    <div className="giphy-overlay" aria-hidden="true">
      {shares.map((share) => {
        return <div
          key={share.shareId}
          className="giphy-share-float"
          data-giphy-share-id={share.shareId}
          style={{
            animationDuration: `${LIMITS.giphyShareLifetimeMs}ms`
          }}
        >
          <img src={share.media.imageUrl} alt="" loading="eager" />
        </div>;
      })}
    </div>
  );
}
