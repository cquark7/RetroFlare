export const MUSIC_MOODS = {
  lofi: {
    label: "Lo-fi",
    tracks: [
      { title: "Shimmer", src: "/music/lofi-shimmer.mp3" },
      { title: "Peaceful Drift", src: "/music/lofi-peaceful-drift.mp3" },
      { title: "Yet Again", src: "/music/lofi-yet-again.mp3" }
    ]
  },
  ambient: {
    label: "Ambient",
    tracks: [
      { title: "Calm Ambient 1", src: "/music/ambient-synthwave-4k.mp3" },
      { title: "Calm Ambient 3", src: "/music/ambient-lifewave-2k.mp3" }
    ]
  },
  piano: {
    label: "Soft piano",
    tracks: [
      { title: "Drifting Piano", src: "/music/piano-drifting.mp3" },
      { title: "Game Travel 1", src: "/music/piano-game-travel.mp3" }
    ]
  }
} as const;

export type MusicMood = keyof typeof MUSIC_MOODS;

export function isMusicMood(value: unknown): value is MusicMood {
  return typeof value === "string" && Object.hasOwn(MUSIC_MOODS, value);
}
