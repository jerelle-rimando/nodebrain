import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
}

type Listener = (toast: ToastMessage) => void;
const listeners: Listener[] = [];

export const toast = {
  success: (message: string) => emit({ id: Date.now().toString(), type: 'success', message }),
  error: (message: string) => emit({ id: Date.now().toString(), type: 'error', message }),
  warning: (message: string) => emit({ id: Date.now().toString(), type: 'warning', message }),
};

function emit(t: ToastMessage) {
  listeners.forEach((l) => l(t));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (t: ToastMessage) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 4000);
    };
    listeners.push(handler);
    return () => {
      const i = listeners.indexOf(handler);
      if (i > -1) listeners.splice(i, 1);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm animate-slide-up min-w-64 max-w-sm ${
            t.type === 'success'
              ? 'bg-brain-surface border-brain-success/30 text-brain-text'
              : t.type === 'error'
              ? 'bg-brain-surface border-brain-error/30 text-brain-text'
              : 'bg-brain-surface border-brain-warning/30 text-brain-text'
          }`}
        >
          {t.type === 'success' && <CheckCircle size={15} className="text-brain-success flex-shrink-0" />}
          {t.type === 'error' && <XCircle size={15} className="text-brain-error flex-shrink-0" />}
          {t.type === 'warning' && <AlertTriangle size={15} className="text-brain-warning flex-shrink-0" />}
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            className="text-brain-text-dim hover:text-brain-text flex-shrink-0"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}