import { useEffect, useRef, useState } from 'preact/hooks';

declare global {
  interface Window { BarcodeDetector?: any }
}

export function useScanner(video: { current: HTMLVideoElement | null }, active: boolean, onCode: (code: string) => void) {
  const [error, setError] = useState('');
  const [engine, setEngine] = useState('');
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    if (!active || !video.current) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let zxingControls: { stop: () => void } | null = null;

    (async () => {
      try {
        const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
        const native = window.BarcodeDetector && (await window.BarcodeDetector.getSupportedFormats?.())?.some((f: string) => formats.includes(f));
        if (native) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
          if (stopped) return;
          video.current!.srcObject = stream;
          await video.current!.play();
          const det = new window.BarcodeDetector({ formats });
          setEngine('native');
          const tick = async () => {
            if (stopped) return;
            try {
              const codes = await det.detect(video.current!);
              if (codes[0]?.rawValue) cb.current(codes[0].rawValue);
            } catch { /* frame not ready */ }
            timer = window.setTimeout(tick, 200);
          };
          void tick();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const reader = new BrowserMultiFormatReader();
          setEngine('zxing');
          zxingControls = await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video.current!, (res) => {
            if (res) cb.current(res.getText());
          });
          if (stopped) zxingControls.stop();
        }
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? 'Camera permission denied' : `Camera unavailable: ${(e as Error).message}`);
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);
  return { error, engine };
}

export function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 1200; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.08);
    navigator.vibrate?.(40);
  } catch { /* no audio */ }
}

