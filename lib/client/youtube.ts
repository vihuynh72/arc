// Loads the YouTube IFrame Player API once. Used by components/VideoPlayer.tsx.
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  mute(): void;
  unMute(): void;
  destroy(): void;
}
export interface YTApi {
  Player: new (
    el: HTMLElement,
    opts: { videoId: string; width?: string | number; height?: string | number; playerVars?: Record<string, string | number>; events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void } },
  ) => YTPlayer;
}

export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_ENDED = 0;
export const YT_BUFFERING = 3;

let loading: Promise<YTApi> | undefined;

export function loadYouTube(): Promise<YTApi> {
  const w = window as unknown as { YT?: YTApi; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  loading ??= new Promise<YTApi>((ok, fail) => {
    w.onYouTubeIframeAPIReady = () => ok(w.YT as YTApi);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      loading = undefined; // offline now, maybe not next time
      fail(new Error("The YouTube player script did not load."));
    };
    document.head.append(s);
  });
  return loading;
}
