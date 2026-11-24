/* Visible-only local polling discovers Agent jobs without submitting or retrying generation. */
(() => {
  'use strict';
  const A = window.AIMedia;
  const invalid = () => Object.assign(new Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE' });
  A.recordsPageController = ({ state: s, invoke }) => {
    let alive = true, timer = null, flight = null, epoch = 0, loading = false, deleting = false, error = '';
    const jobs = new Map(), reads = new Map();
    const live = () => alive && s.alive;
    const visible = () => live() && s.screen === 'records' && !document.hidden;
    const disabled = () => deleting || s.legacyBackend || !s.data || s.busy;
    const preview = A.resultPreviewController({ live, disabled, showing: id => records.showing(id), paint: () => { if (visible()) records.update(); },
      read: (job, offset) => invoke('aimedia.records.read', { kind: job.kind, jobId: job.id, expectedSha256: job.result.sha256, offset }) });
    const records = A.recordsController({ state: s, disabled, refresh, getJob, regenerateRecord, deleteRecords,
      allJobs: () => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      listState: () => ({ loading, error }), clearPreview: preview.clear, loadResult: preview.load, previewView: preview.view, previewKey: preview.key });
    function remember(job) {
      if (!job || !['image', 'audio', 'workflow'].includes(job.kind) || typeof job.id !== 'string' || !job.id.startsWith(job.kind === 'audio' ? 'aud-' : job.kind === 'workflow' ? 'wf-' : 'img-') || !Number.isInteger(job.revision) || !job.request || typeof job.createdAt !== 'string') throw invalid();
      const old = jobs.get(job.id);
      if (old && old.revision > job.revision) return old;
      const next = { ...job, request: { ...old?.request, ...job.request } };
      jobs.set(job.id, next); return next;
    }
    function schedule() {
      clearTimeout(timer); timer = null;
      if (visible() && !disabled() && !flight) timer = setTimeout(() => { timer = null; void refresh(); }, 1500);
    }
    function refresh() {
      if (!visible() || disabled()) { schedule(); return Promise.resolve(); }
      if (flight) return flight;
      const ticket = epoch;
      loading = true; error = ''; records.update();
      flight = (async () => {
        try {
          const result = await invoke('aimedia.records.list', {});
          if (!visible() || ticket !== epoch) return;
          if (!Array.isArray(result?.jobs)) throw invalid();
          for (const job of result.jobs) remember(job);
        } catch (failure) { if (visible() && ticket === epoch) error = A.errorText(failure); }
        finally {
          flight = null; loading = false;
          if (visible()) { records.update(); schedule(); }
        }
      })();
      return flight;
    }
    function getJob(id) {
      if (!live() || disabled()) return Promise.resolve(null);
      if (reads.has(id)) return reads.get(id);
      const kind = jobs.get(id)?.kind;
      const read = (async () => {
        try {
          const job = await invoke('aimedia.records.get', { kind, jobId: id });
          if (!live()) return null;
          if (job.id !== id || job.kind !== kind) throw invalid();
          return remember(job);
        } finally { reads.delete(id); }
      })();
      reads.set(id, read); return read;
    }
    async function regenerateRecord(job) {
      if (!job || !visible() || disabled()) return false;
      const ticket = epoch;
      try {
        const result = await invoke('aimedia.records.regenerate', { kind: job.kind, jobId: job.id, confirm: true });
        if (!visible() || ticket !== epoch || !result?.id) return false;
        remember(result); return true;
      } catch (failure) {
        if (visible() && ticket === epoch) error = A.errorText(failure);
        return false;
      } finally { if (visible() && ticket === epoch) records.update(); }
    }
    async function deleteRecords(selected) {
      if (!selected.length || !visible() || disabled()) return false;
      const ticket = epoch;
      deleting = true; error = ''; records.update();
      try {
        const result = await invoke('aimedia.records.delete', { records: selected.map(job => ({ kind: job.kind, jobId: job.id })), confirm: true });
        if (!visible() || ticket !== epoch || !Array.isArray(result?.deleted) || result.deleted.length !== selected.length) return false;
        for (const job of selected) jobs.delete(job.id);
        return true;
      } catch (failure) {
        if (visible() && ticket === epoch) error = A.errorText(failure);
        return false;
      } finally {
        deleting = false;
        if (visible() && ticket === epoch) records.update();
      }
    }
    function screenChanged() { epoch++; records.closeDetails(false); preview.clear(); schedule(); }
    function visibilityChanged() {
      epoch++; clearTimeout(timer); timer = null;
      if (visible()) void refresh();
    }
    document.addEventListener('visibilitychange', visibilityChanged);
    return { view: records.view, refresh, screenChanged,
      dispose() { alive = false; epoch++; clearTimeout(timer); records.dispose(); preview.clear(); jobs.clear(); reads.clear(); document.removeEventListener('visibilitychange', visibilityChanged); } };
  };
})();
