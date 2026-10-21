import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { desktopApi } from '../lib/product-fetch';
import { modelReadiness, type ModelSetup } from './model-readiness';

export function useModelReadiness(active = true) {
  const [setup, setSetup] = useState<ModelSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current;
    setLoading(true); setError('');
    try {
      const desktop = desktopApi();
      let next: ModelSetup;
      if (desktop) next = (await desktop.getSetup(true)).setup.current;
      else {
        const overview = await api.brainOverview();
        next = { chatModel: overview.chat_model, embeddingModel: overview.embedding_model, embeddingDimensions: overview.embedding_dimensions };
      }
      if (id === request.current) setSetup(next);
      return next;
    } catch (reason) {
      if (id === request.current) { setSetup(null); setError(reason instanceof Error ? reason.message : String(reason)); }
    } finally { if (id === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pmbrain:models-updated', refresh);
    return () => { request.current++; window.removeEventListener('focus', refresh); window.removeEventListener('pmbrain:models-updated', refresh); };
  }, [active, reload]);
  return { setup, readiness: setup ? modelReadiness(setup) : null, loading, error, reload };
}
