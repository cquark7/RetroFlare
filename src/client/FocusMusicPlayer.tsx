import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isMusicMood, MUSIC_MOODS, type MusicMood } from "./music/catalog";
import { Icon } from "./icons";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "./storage-keys";

type MusicPreferences = {
  mood: MusicMood;
  volume: number;
};

// Exposes the level to CSS so the slider track can fill up to the thumb.
type VolumeStyle = CSSProperties & { "--volume": number };

const DEFAULT_PREFERENCES: MusicPreferences = { mood: "lofi", volume: 0.2 };
function readPreferences(actorId: string): MusicPreferences {
  try {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}music:${actorId}`)
      ?? localStorage.getItem(`${LEGACY_STORAGE_PREFIX}music:${actorId}`);
    if (!stored) return DEFAULT_PREFERENCES;

    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_PREFERENCES;
    const value = parsed as Record<string, unknown>;
    const volume = typeof value.volume === "number" && Number.isFinite(value.volume)
      ? Math.min(1, Math.max(0, value.volume))
      : DEFAULT_PREFERENCES.volume;
    return {
      mood: isMusicMood(value.mood) ? value.mood : DEFAULT_PREFERENCES.mood,
      volume
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function savePreferences(actorId: string, preferences: MusicPreferences): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}music:${actorId}`, JSON.stringify(preferences));
  } catch {
    // Music preferences are optional; storage failures should not affect the board.
  }
}

export function FocusMusicPlayer({ actorId }: { actorId: string }) {
  const [preferences, setPreferences] = useState(() => readPreferences(actorId));
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string>();
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioSourceRef = useRef<string | undefined>(undefined);
  const isPlayingRef = useRef(false);
  const playbackRequestRef = useRef(0);
  const tracks = MUSIC_MOODS[preferences.mood].tracks;
  const currentTrack = tracks[trackIndex] ?? tracks[0]!;

  useEffect(() => {
    savePreferences(actorId, preferences);
  }, [actorId, preferences]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && audioSourceRef.current !== currentTrack.src) {
      audio.src = currentTrack.src;
      audioSourceRef.current = currentTrack.src;
    }
  }, [currentTrack.src]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = preferences.volume;
  }, [preferences.volume]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      playbackRequestRef.current += 1;
      isPlayingRef.current = false;
      audioSourceRef.current = undefined;
      if (!audio) return;
      audio.pause();
      try { audio.currentTime = 0; } catch { /* An unplayed source may have no seekable range. */ }
      audio.removeAttribute("src");
      audio.load();
    };
  }, []);

  const startPlayback = async (audio: HTMLAudioElement) => {
    const request = ++playbackRequestRef.current;
    isPlayingRef.current = true;
    setIsPlaying(true);
    setPlaybackError(undefined);
    try {
      await audio.play();
      if (playbackRequestRef.current === request) setPlaybackError(undefined);
    } catch {
      if (playbackRequestRef.current !== request) return;
      isPlayingRef.current = false;
      setIsPlaying(false);
      setPlaybackError("Music couldn’t start. Press Play to try again or choose another mood.");
    }
  };

  const pausePlayback = () => {
    playbackRequestRef.current += 1;
    audioRef.current?.pause();
    isPlayingRef.current = false;
    setIsPlaying(false);
    setPlaybackError(undefined);
  };

  const changeMood = (mood: MusicMood) => {
    const nextTrack = MUSIC_MOODS[mood].tracks[0]!;
    const audio = audioRef.current;
    const shouldResume = isPlayingRef.current;
    setPreferences((current) => ({ ...current, mood }));
    setTrackIndex(0);
    setPlaybackError(undefined);

    if (!audio) return;
    playbackRequestRef.current += 1;
    audio.pause();
    audio.src = nextTrack.src;
    audioSourceRef.current = nextTrack.src;
    if (shouldResume) void startPlayback(audio);
    else {
      isPlayingRef.current = false;
      setIsPlaying(false);
    }
  };

  const handleEnded = () => {
    const nextIndex = (trackIndex + 1) % tracks.length;
    const nextTrack = tracks[nextIndex]!;
    const audio = audioRef.current;
    setTrackIndex(nextIndex);
    if (!audio) return;
    audio.src = nextTrack.src;
    audioSourceRef.current = nextTrack.src;
    void startPlayback(audio);
  };

  const handleVolumeChange = (value: number) => {
    const volume = Math.min(1, Math.max(0, value));
    setPreferences((current) => ({ ...current, volume }));
    if (audioRef.current) audioRef.current.volume = volume;
  };

  const handleAudioError = () => {
    playbackRequestRef.current += 1;
    isPlayingRef.current = false;
    setIsPlaying(false);
    setPlaybackError("This track couldn’t be loaded. Choose another mood or try again.");
  };

  const volumeStyle: VolumeStyle = { "--volume": preferences.volume };

  return (
    <div className="focus-music" role="group" aria-label="Personal background music">
      <label className="focus-music__mood-control">
        <span className="focus-music__label"><Icon name="music" size={14} /><span className="focus-music__label-text">Music</span></span>
        <select aria-label="Music mood" value={preferences.mood} onChange={(event) => {
          const mood = event.currentTarget.value;
          if (isMusicMood(mood)) changeMood(mood);
        }}>
          {(Object.keys(MUSIC_MOODS) as MusicMood[]).map((mood) => <option key={mood} value={mood}>{MUSIC_MOODS[mood].label}</option>)}
        </select>
      </label>
      <button className="button button--quiet focus-music__toggle" type="button" title={currentTrack.title} aria-label={isPlaying ? "Pause personal music" : "Play personal music"} aria-pressed={isPlaying} onClick={() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (isPlayingRef.current) pausePlayback();
        else void startPlayback(audio);
      }}>
        <Icon name={isPlaying ? "pause" : "play"} size={12} />
        <span className="focus-music__toggle-label">{isPlaying ? "Pause" : "Play"}</span>
      </button>
      <label className="focus-music__volume">
        <span className="visually-hidden">Music volume</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={preferences.volume}
          style={volumeStyle}
          aria-label="Music volume"
          onChange={(event) => handleVolumeChange(event.currentTarget.valueAsNumber)}
        />
      </label>
      {playbackError && <span className="focus-music__error" role="status">{playbackError}</span>}
      <audio ref={audioRef} className="focus-music__audio" data-focus-music="true" preload="none" onEnded={handleEnded} onError={handleAudioError} />
    </div>
  );
}
