/* Shared local result verification. A preview owns its decoder, media element and Blob URL. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const { h, button, note } = A;
  const failure = () => Object.assign(new Error('RESULT_INVALID'), { code: 'RESULT_INVALID' });
  A.audioDuration = ms => `${(ms / 1000).toFixed(2)} 秒`;
  A.resultPreviewController = ({ live, disabled, showing, read, paint }) => {
    let ticket = 0, preview = null;
    function release(value) {
      value?.cancel?.();
      if (value?.media instanceof HTMLMediaElement) {
        value.media.pause(); value.media.removeAttribute('src'); value.media.load();
      } else value?.media?.removeAttribute('src');
      if (value?.url) { URL.revokeObjectURL(value.url); value.url = null; }
    }
    function clear() { ticket++; release(preview); preview = null; }
    function metadata(audio, value) {
      return new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timeout); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed);
          value.cancel = null; error ? reject(error) : resolve();
        };
        const loaded = () => finish(), failed = () => finish(failure());
        const timeout = setTimeout(failed, 15000);
        value.cancel = failed;
        audio.addEventListener('loadedmetadata', loaded, { once: true });
        audio.addEventListener('error', failed, { once: true });
        audio.src = value.url; audio.load();
      });
    }
    async function load(job) {
      if (!live() || disabled() || !showing(job.id) || !job.result || preview?.id === job.id && preview.hash === job.result.sha256) return;
      clear();
      const ownTicket = ticket, result = job.result, audio = job.kind === 'audio';
      const value = preview = { id: job.id, hash: result.sha256, loading: true, url: null, media: null, error: '', node: null };
      const current = () => live() && showing(job.id) && ownTicket === ticket;
      paint();
      try {
        const mime = audio ? 'audio/mpeg' : 'image/png';
        if (result.mimeType !== mime || result.verification !== (audio ? 'mp3-frames-validated' : 'png-validated') || !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > 16 * 1024 * 1024) throw failure();
        if (audio && (!Number.isFinite(result.durationMs) || result.durationMs <= 0 || result.durationMs > 600000 || ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(result.sampleRate) || ![1, 2].includes(result.channels))) throw failure();
        const chunks = []; let offset = 0;
        for (let index = 0; offset < result.byteLength && index < 4096; index++) {
          const chunk = await read(job, offset);
          if (!current()) return;
          if (chunk.jobId !== job.id || chunk.mimeType !== mime || chunk.sha256 !== result.sha256 || chunk.totalBytes !== result.byteLength || chunk.offset !== offset || typeof chunk.base64 !== 'string' || chunk.base64.length > 87384) throw failure();
          const bytes = Uint8Array.from(atob(chunk.base64), character => character.charCodeAt(0));
          if (!bytes.length || bytes.length > 65536 || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > result.byteLength || chunk.eof !== (chunk.nextOffset === result.byteLength)) throw failure();
          chunks.push(bytes); offset = chunk.nextOffset;
        }
        if (offset !== result.byteLength) throw failure();
        const blob = new Blob(chunks, { type: mime }), bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        if (!current()) return;
        if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== result.sha256) throw failure();
        if (audio) {
          // MP3 encoder padding/gapless trimming can change decoded duration by a few frames.
          const tolerance = Math.max(150, result.durationMs * .01);
          const decoder = new OfflineAudioContext(result.channels, 1, result.sampleRate);
          const decoded = await decoder.decodeAudioData(bytes);
          if (!current()) return;
          if (decoded.numberOfChannels !== result.channels || Math.abs(decoded.duration * 1000 - result.durationMs) > tolerance) throw failure();
          value.url = URL.createObjectURL(blob);
          value.media = h('audio', { controls: true, preload: 'metadata', 'aria-label': '生成语音预览', tabindex: 0 });
          await metadata(value.media, value);
          if (!current()) return;
          if (!Number.isFinite(value.media.duration) || Math.abs(value.media.duration * 1000 - result.durationMs) > tolerance) throw failure();
        } else {
          value.url = URL.createObjectURL(blob);
          value.media = new Image(); value.media.alt = '生成图片预览'; value.media.src = value.url;
          await value.media.decode();
          if (!current()) return;
          if (value.media.naturalWidth !== result.width || value.media.naturalHeight !== result.height) throw failure();
        }
        value.node = h('div', { class: `generation-result${audio ? ' audio-result' : ''}` }, value.media,
          h('div', { class: 'generation-result-actions' }, h('a', { class: 'generation-download', href: value.url, download: `${job.id}.${audio ? 'mp3' : 'png'}` }, audio ? '下载 MP3' : '下载 PNG'),
            h('span', { class: 'muted' }, audio ? `${A.audioDuration(result.durationMs)} · ${result.sampleRate} Hz · ${result.channels} 声道 · 内容未评审` : `${result.width} × ${result.height} · 画面质量未评审`)));
      } catch (error) {
        if (!current()) return;
        release(value);
        const name = audio ? '音频' : '图片';
        value.error = error.code === 'RESULT_UNAVAILABLE' ? `本地${name}暂不可用，请重新读取任务核对。不会重新生成。` : `${name}无法通过完整性检查或浏览器解码，无法预览和下载。不会重新生成。`;
      } finally { if (current()) { value.loading = false; paint(); } }
    }
    function view(job) {
      const audio = job.kind === 'audio', name = audio ? '音频' : '图片';
      if (!job.result) return note(`暂无可读取的本地${name}。`);
      if (preview?.id !== job.id) return h('div', { class: 'block' }, button(`预览${name}`, () => load(job), { disabled: disabled() }));
      if (preview.loading) return h('p', { class: 'note', role: 'status' }, `正在读取本地 ${audio ? 'MP3' : 'PNG'} 并解码…`);
      if (preview.error) return h('div', {}, h('p', { class: 'generation-error', role: 'alert' }, preview.error),
        button(`重试读取${name}`, () => { clear(); void load(job); }, { disabled: disabled() }));
      return preview.node;
    }
    return { load, clear, view, key: () => `${ticket}:${preview?.loading}:${preview?.error || ''}`, failed: id => preview?.id === id && Boolean(preview.error) };
  };
})();
