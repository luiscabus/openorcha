import { api, toast } from '../utils.js';
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/addon-fit.mjs';

class DrawerLiveTerminal {
  constructor() {
    this.root = null;
    this.host = null;
    this.overlay = null;
    this.meta = null;
    this.title = null;
    this.term = null;
    this.fitAddon = null;
    this.socket = null;
    this.resizeObserver = null;
    this.target = null;
    this.active = false;
    this.connected = false;
    this.handleResize = this.handleResize.bind(this);
    this.handlePaste = this.handlePaste.bind(this);
    this.fitTimer = null;
  }

  init() {
    if (this.root) return;
    this.root = document.getElementById('drawer-live-terminal');
    this.host = document.getElementById('drawer-live-shell');
    this.overlay = document.getElementById('drawer-live-overlay');
    this.meta = document.getElementById('drawer-live-meta');
    this.title = document.getElementById('drawer-live-title');

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: true,
      convertEol: false,
      theme: {
        background: '#08131f',
        foreground: '#d7e0ea',
        cursor: '#8ec5ff',
        cursorAccent: '#08131f',
        selectionBackground: 'rgba(142,197,255,0.22)',
        black: '#1f2937',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e5e7eb',
        brightBlack: '#4b5563',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f9fafb',
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.host);

    this.term.onData((data) => {
      if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: 'input', data }));
    });

    this.term.onResize(({ cols, rows }) => {
      if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      this.updateMeta();
    });

    this.root.addEventListener('mousedown', () => this.term.focus());
    this.root.addEventListener('paste', this.handlePaste, { capture: true });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.root);
    } else {
      window.addEventListener('resize', this.handleResize);
    }
  }

  activate(target) {
    this.init();
    this.active = true;
    this.target = target;
    this.updateTitle(target?.sessionName || 'tmux');
    this.scheduleFit();
    this.connect();
  }

  deactivate() {
    this.active = false;
    this.connected = false;
    this.target = null;
    if (this.socket) {
      this.socket._drawerManualClose = true;
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    if (this.term) {
      this.term.clear();
      this.term.reset();
    }
    if (this.fitTimer) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    this.setOverlay('');
    this.updateMeta('');
  }

  refresh() {
    if (!this.active || !this.target) return;
    this.connect();
  }

  handleResize() {
    if (!this.active) return;
    this.scheduleFit();
  }

  handlePaste(event) {
    if (!this.active) return;
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text) return;
    this.term.focus();
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'input', data: text }));
  }

  isVisible() {
    return !!(
      this.active &&
      this.root &&
      this.host &&
      this.root.offsetParent !== null &&
      this.root.clientWidth > 40 &&
      this.root.clientHeight > 40 &&
      this.host.clientWidth > 40 &&
      this.host.clientHeight > 40
    );
  }

  async waitForVisibleLayout() {
    let stableFrames = 0;
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!this.active) return false;
      if (!this.isVisible()) {
        stableFrames = 0;
        continue;
      }
      stableFrames += 1;
      if (stableFrames >= 2) return true;
    }
    return this.isVisible();
  }

  fitTerminal() {
    if (!this.term || !this.fitAddon || !this.isVisible()) return false;
    try {
      this.fitAddon.fit();
      this.updateMeta();
      return true;
    } catch {
      return false;
    }
  }

  scheduleFit(delay = 0) {
    if (!this.active) return;
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      if (!this.active) return;
      if (!this.fitTerminal()) this.scheduleFit(80);
    }, delay);
  }

  async preloadHistory() {
    if (!this.target || !this.term) return;
    try {
      const url = this.target.pid
        ? `/api/agents/${this.target.pid}/terminal-snapshot`
        : `/api/agents/tmux-terminal/${encodeURIComponent(this.target.sessionName)}/snapshot`;
      const data = await api('GET', url);
      const content = data?.content || '';
      if (!content) return;
      const normalized = content.replace(/\r?\n/g, '\r\n');
      this.term.clear();
      this.term.reset();
      this.term.write(normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`);
    } catch {}
  }

  connect() {
    if (!this.target) return;

    this.connected = false;
    if (this.socket) {
      this.socket._drawerManualClose = true;
      try { this.socket.close(); } catch {}
      this.socket = null;
    }

    this.term.clear();
    this.term.reset();
    this.setOverlay('Loading tmux history…');

    requestAnimationFrame(async () => {
      const ready = await this.waitForVisibleLayout();
      if (!ready || !this.active || !this.target) return;
      this.fitTerminal();
      await this.preloadHistory();
      if (!this.active || !this.target) return;
      this.setOverlay('Connecting to tmux…');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (this.target.pid) params.set('pid', String(this.target.pid));
      else if (this.target.sessionName) params.set('session', this.target.sessionName);
      params.set('cols', String(this.term.cols || 120));
      params.set('rows', String(this.term.rows || 34));

      this.socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?${params.toString()}`);
      this.socket._drawerManualClose = false;

      this.socket.addEventListener('open', () => {
        this.connected = true;
        this.setOverlay('');
        this.updateMeta();
        this.scheduleFit();
        this.scheduleFit(60);
        this.scheduleFit(180);
        this.term.focus();
      });

      this.socket.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'ready') {
          this.updateTitle(msg.sessionName || this.target?.sessionName || 'tmux');
          this.updateMeta();
          return;
        }
        if (msg.type === 'reset') {
          this.term.clear();
          this.term.reset();
          return;
        }
        if (msg.type === 'output') {
          this.term.write(msg.data || '');
          return;
        }
        if (msg.type === 'error') {
          this.setOverlay(msg.message || 'Terminal connection failed');
          toast(msg.message || 'Terminal connection failed', 'error');
          return;
        }
        if (msg.type === 'exit') {
          this.connected = false;
          this.updateMeta('detached');
          this.setOverlay('tmux client closed');
        }
      });

      this.socket.addEventListener('close', (event) => {
        this.connected = false;
        if (this.active && !event.target?._drawerManualClose) {
          this.updateMeta('disconnected');
          this.setOverlay('Terminal disconnected');
        }
      });

      this.socket.addEventListener('error', () => {
        this.connected = false;
        if (this.active) {
          this.updateMeta('error');
          this.setOverlay('Terminal connection error');
        }
      });
    });
  }

  setOverlay(message) {
    if (!this.overlay) return;
    this.overlay.textContent = message || '';
    this.overlay.style.display = message ? 'flex' : 'none';
  }

  updateTitle(text) {
    if (this.title) this.title.textContent = text || 'tmux';
  }

  updateMeta(status = '') {
    if (!this.meta || !this.term) return;
    const parts = [];
    if (this.term.cols && this.term.rows) parts.push(`${this.term.cols}x${this.term.rows}`);
    parts.push(this.connected ? 'streaming' : (status || 'connecting'));
    parts.push('native scrollback');
    if (status && this.connected) parts.push(status);
    this.meta.textContent = parts.join(' • ');
  }
}

const drawerLiveTerminal = new DrawerLiveTerminal();

export function activateDrawerLiveTerminal(target) {
  drawerLiveTerminal.activate(target);
}

export function deactivateDrawerLiveTerminal() {
  drawerLiveTerminal.deactivate();
}

export function refreshDrawerLiveTerminal() {
  drawerLiveTerminal.refresh();
}
