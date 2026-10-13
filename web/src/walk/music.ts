/** Background music for walk mode: freely licensed loops from public/music/tracks.json (missing files are skipped). */
interface Track { file: string; title: string; author: string; license: string; url: string }

export class Music {
  private audio: HTMLAudioElement | null = null;
  private tracks: Track[] = [];
  private k = 0;
  private loaded = false;
  private muted = false;
  readonly button: HTMLButtonElement;
  private active = false;

  constructor(private volume = 0.22) {
    this.button = document.createElement('button');
    this.button.className = 'wmusic';
    this.button.hidden = true;
    this.button.onclick = () => this.toggle();
    try { this.muted = localStorage.getItem('codecity.music') === 'off'; } catch { /* storage unavailable */ }
    this.label();
  }

  private label() {
    const t = this.tracks[this.k];
    this.button.textContent = this.muted ? 'Music off (P)' : 'Music (P)';
    this.button.title = t ? `${t.title} · ${t.author} · ${t.license}` : '';
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const list = (await (await fetch('./music/tracks.json')).json()) as Track[];
      for (const t of list) {
        const r = await fetch('./music/' + t.file, { method: 'HEAD' }).catch(() => null);
        // a dev/static server may answer unknown paths with index.html: require an audio type
        if (r?.ok && (r.headers.get('content-type') ?? '').startsWith('audio')) this.tracks.push(t);
      }
    } catch { /* no manifest: silent */ }
    this.button.hidden = this.tracks.length === 0;
    this.label();
  }

  private play() {
    const t = this.tracks[this.k];
    if (!t || this.muted || !this.active) return;
    if (!this.audio) {
      this.audio = new Audio('./music/' + t.file);
      this.audio.volume = this.volume;
      this.audio.loop = this.tracks.length === 1;
      this.audio.onended = () => { this.k = (this.k + 1) % this.tracks.length; this.audio = null; this.play(); };
    }
    void this.audio.play().catch(() => { /* needs a user gesture; the next key press retries */ });
  }

  /** Walk mode started (called from a key press, so autoplay is allowed). */
  async start() {
    this.active = true;
    await this.load();
    this.play();
  }

  stop() { this.active = false; this.audio?.pause(); }

  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem('codecity.music', this.muted ? 'off' : 'on'); } catch { /* ignore */ }
    if (this.muted) this.audio?.pause(); else this.play();
    this.label();
  }
}
