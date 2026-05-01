/**
 * /kiosk/qr-scan — camera-driven QR check-in.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.3
 *
 * Library choice: jsqr.
 *   - 40 KB pure-JS, no canvas dependency beyond the standard one. Runs
 *     inside the page, no service worker or worker thread (overkill for
 *     a kiosk that only scans one code at a time).
 *   - Returns immediately with `null` when no code is found, so we can
 *     poll on every frame via `requestAnimationFrame` without backpressure.
 *   - Alternatives evaluated: @zxing/browser (pulls a heavier multi-format
 *     decoder we don't need), qr-scanner (worker-based; more correct but
 *     adds bundle weight + worker plumbing). For v1 jsqr is the right
 *     trade-off.
 *
 * Camera handling:
 *   - We request `facingMode: 'environment'` (rear camera) when available.
 *     Most lobby kiosks face the visitor with the front camera; we fall
 *     back to `facingMode: 'user'` if the rear camera isn't accessible.
 *     A device-aware admin can override via tablet OS camera settings.
 *   - Permission denial → friendly message + button to switch to the
 *     name-typed flow. We never block the visitor on a camera issue.
 *
 * Errors from the backend:
 *   - 401 / "Invalid or unknown token" → "Sorry, that QR code isn't
 *     recognized. Please ask reception."
 *   - 403 / "already used" → "This QR has already been scanned. Please
 *     see reception."
 *   - 403 / "expired" → "This invitation has expired. Please ask your
 *     host to re-invite."
 *   - Other 4xx → fallback "Please see reception."
 *   - Network → optimistic queue (offline path), confirmation screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import { ArrowLeft, Camera, CameraOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { mapBackendError } from '@/api/visitors/kiosk-errors';
import { checkInQrOrQueue } from '@/api/visitors/kiosk';

type ScanState =
  | { kind: 'requesting' }
  | { kind: 'scanning' }
  | { kind: 'denied' }
  | { kind: 'no-camera' }
  | { kind: 'submitting' }
  | { kind: 'error'; title: string; message: string };

const TIMEOUT_MS = 60_000;

export function KioskQrScanPage() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decodedRef = useRef<boolean>(false);
  const [state, setState] = useState<ScanState>({ kind: 'requesting' });

  // Inner functions live in refs so the camera-start effect can run once
  // on mount without restarting whenever a state-derived dependency
  // updates. Restarting mid-submit would tear down the stream while the
  // backend call is still in flight — wrong.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const stop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const handleDecoded = useCallback(
    async (token: string) => {
      if (decodedRef.current) return;
      decodedRef.current = true;
      stop();
      setState({ kind: 'submitting' });
      try {
        const outcome = await checkInQrOrQueue(token);
        if (outcome.mode === 'queued') {
          navigateRef.current('/kiosk/confirmation', {
            replace: true,
            state: {
              hostFirstName: null,
              hasReceptionAtBuilding: true,
              queued: true,
            },
          });
          return;
        }
        navigateRef.current('/kiosk/confirmation', {
          replace: true,
          state: {
            hostFirstName: outcome.result.host_first_name,
            hasReceptionAtBuilding: outcome.result.has_reception_at_building,
            queued: false,
          },
        });
      } catch (err) {
        decodedRef.current = false;
        const mapped = mapBackendError(err, 'qr');
        setState({ kind: 'error', title: mapped.title, message: mapped.message });
      }
    },
    [stop],
  );

  // Refs so tick + startCamera can pull the latest function without
  // depending on it (preventing effect re-runs mid-flow).
  const handleDecodedRef = useRef(handleDecoded);
  handleDecodedRef.current = handleDecoded;

  const tick = useCallback(() => {
    if (decodedRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code?.data) {
      void handleDecodedRef.current(code.data);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const tickRef = useRef(tick);
  tickRef.current = tick;

  const startCamera = useCallback(async () => {
    decodedRef.current = false;
    setState({ kind: 'requesting' });

    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ kind: 'no-camera' });
      return;
    }

    let stream: MediaStream | null = null;
    try {
      // Prefer the rear camera (visitor faces the device, holds QR up to
      // the screen-side). Fall back to user-facing on devices without a
      // rear camera or where the rear camera is denied independently.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
      }
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        name === 'SecurityError'
      ) {
        setState({ kind: 'denied' });
      } else {
        setState({ kind: 'no-camera' });
      }
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* iOS sometimes throws when autoplay races; we'll catch on next loop */
    }

    setState({ kind: 'scanning' });
    tickRef.current();
  }, []);

  // 60s timeout — back to idle.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      navigateRef.current('/kiosk', { replace: true });
    }, TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Mount-only — start the camera once, stop once on unmount. Re-runs of
  // this effect would restart the camera mid-submit, which is wrong.
  useEffect(() => {
    void startCamera();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <Button
          variant="ghost"
          size="lg"
          className="h-14 gap-2 text-lg"
          onClick={() => navigate('/kiosk', { replace: true })}
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
          Cancel
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          Scan your invitation QR
        </h1>
        <div className="w-[120px]" /> {/* spacer */}
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        {state.kind === 'denied' ? (
          <DeniedView
            onTryName={() => navigate('/kiosk/name-fallback')}
            onRetry={() => startCamera()}
          />
        ) : state.kind === 'no-camera' ? (
          <NoCameraView onTryName={() => navigate('/kiosk/name-fallback')} />
        ) : state.kind === 'error' ? (
          <ErrorView
            title={state.title}
            message={state.message}
            onRetry={() => startCamera()}
            onName={() => navigate('/kiosk/name-fallback')}
          />
        ) : state.kind === 'submitting' ? (
          <div className="text-2xl font-medium text-muted-foreground">
            Checking you in…
          </div>
        ) : (
          <ScannerView
            videoRef={videoRef}
            canvasRef={canvasRef}
            requesting={state.kind === 'requesting'}
          />
        )}
      </div>
    </div>
  );
}

function ScannerView({
  videoRef,
  canvasRef,
  requesting,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  requesting: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative overflow-hidden rounded-2xl border-2 bg-black">
        <video
          ref={videoRef}
          className="h-[420px] w-[560px] object-cover"
          playsInline
          muted
        />
        {/* sr-only keeps the element rendered (so the rasterization path
             jsQR depends on isn't broken on browsers that skip
             display:none) while making it invisible / inaccessible. */}
        <canvas ref={canvasRef} className="sr-only" aria-hidden />
        {/* Crosshair */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="size-64 rounded-2xl border-4 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>
      <p className="text-xl text-muted-foreground">
        {requesting
          ? 'Requesting camera…'
          : 'Hold your invitation QR up to the camera.'}
      </p>
    </div>
  );
}

function DeniedView({
  onTryName,
  onRetry,
}: {
  onTryName: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex max-w-xl flex-col items-center gap-6 text-center">
      <CameraOff className="size-16 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-3xl font-semibold tracking-tight">
        Camera access is blocked
      </h2>
      <p className="text-lg text-muted-foreground">
        We can't open the camera on this device. If you just allowed
        camera access, retry. Otherwise type your name to check in.
      </p>
      <div className="flex gap-3">
        <Button
          variant="outline"
          size="lg"
          className="h-14 gap-2 px-6 text-lg"
          onClick={onRetry}
        >
          <RefreshCw className="size-5" aria-hidden="true" />
          Try camera again
        </Button>
        <Button size="lg" className="h-14 px-8 text-lg" onClick={onTryName}>
          Type your name instead
        </Button>
      </div>
    </div>
  );
}

function NoCameraView({ onTryName }: { onTryName: () => void }) {
  return (
    <div className="flex max-w-xl flex-col items-center gap-6 text-center">
      <Camera className="size-16 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-3xl font-semibold tracking-tight">
        No camera available
      </h2>
      <p className="text-lg text-muted-foreground">
        This device doesn't have a working camera. Please type your name to
        continue.
      </p>
      <Button size="lg" className="h-14 px-8 text-lg" onClick={onTryName}>
        Type your name instead
      </Button>
    </div>
  );
}

function ErrorView({
  title,
  message,
  onRetry,
  onName,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  onName: () => void;
}) {
  return (
    <div className="flex max-w-xl flex-col items-center gap-6 text-center">
      <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
      <p className="text-lg text-muted-foreground">{message}</p>
      <div className="flex gap-3">
        <Button
          variant="outline"
          size="lg"
          className="h-14 gap-2 px-6 text-lg"
          onClick={onRetry}
        >
          <RefreshCw className="size-5" aria-hidden="true" />
          Try again
        </Button>
        <Button size="lg" className="h-14 px-6 text-lg" onClick={onName}>
          Type your name
        </Button>
      </div>
    </div>
  );
}

