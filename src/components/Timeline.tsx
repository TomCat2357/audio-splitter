import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useStoreValue } from '../hooks/useStoreValue';
import { formatTime, segmentsFromPoints } from '../lib/plan';
import type { Store } from '../lib/store';
import {
  clampMarkerMove,
  labelFits,
  roundSec,
  secToRatio,
  stepTime,
  xToSec,
} from '../lib/timeline';

interface TimelineProps {
  duration: number;
  points: number[];
  /** マーカーをドラッグ・キー操作で編集できる（手動モードのみ） */
  editable: boolean;
  timeStore: Store<number>;
  seek: (sec: number) => void;
  onMovePoint: (index: number, sec: number) => void;
  onRemovePoint: (index: number) => void;
}

const pct = (r: number) => `${(r * 100).toFixed(4)}%`;

const SegmentsLayer = memo(function SegmentsLayer(props: {
  duration: number;
  points: number[];
  width: number;
  muted: boolean;
}) {
  const { duration, points, width, muted } = props;
  const segs = segmentsFromPoints(points, duration);
  return (
    <div className={`tl-segments${muted ? ' is-preview' : ''}`} aria-hidden="true">
      {segs.map((s, i) => (
        <div
          key={i}
          className={`tl-seg ${i % 2 === 0 ? 'tl-seg-a' : 'tl-seg-b'}`}
          style={{ left: pct(s.start / duration), width: pct((s.end - s.start) / duration) }}
        >
          {labelFits(s.start, s.end, duration, width) && <span className="tl-seg-label">{i + 1}</span>}
        </div>
      ))}
    </div>
  );
});

interface MarkerProps {
  index: number;
  points: number[];
  duration: number;
  getRect: () => DOMRect | undefined;
  onMovePoint: (index: number, sec: number) => void;
  onRemovePoint: (index: number) => void;
}

function Marker({ index, points, duration, getRect, onMovePoint, onRemovePoint }: MarkerProps) {
  const dragging = useRef(false);
  const p = points[index];

  const moveTo = (sec: number) => {
    const allowed = roundSec(clampMarkerMove(points, index, sec, duration));
    if (allowed !== p) onMovePoint(index, allowed);
  };

  return (
    <div
      className="tl-marker"
      style={{ left: pct(secToRatio(p, duration)) }}
      role="slider"
      tabIndex={0}
      aria-label={`分割点 ${index + 1}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(p * 100) / 100}
      aria-valuetext={formatTime(p, { fraction: true })}
      data-testid="timeline-marker"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const r = getRect();
        if (r) moveTo(xToSec(e.clientX, r.left, r.width, duration));
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const step = e.shiftKey ? 0.1 : 1;
          moveTo(p + (e.key === 'ArrowLeft' ? -step : step));
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onRemovePoint(index);
        }
      }}
    >
      <span className="tl-marker-line" />
      <span className="tl-marker-cap" />
    </div>
  );
}

const MarkersLayer = memo(function MarkersLayer(props: {
  duration: number;
  points: number[];
  editable: boolean;
  getRect: () => DOMRect | undefined;
  onMovePoint: (index: number, sec: number) => void;
  onRemovePoint: (index: number) => void;
}) {
  const { duration, points, editable, getRect, onMovePoint, onRemovePoint } = props;
  return (
    <div className="tl-markers">
      {points.map((p, i) =>
        editable ? (
          <Marker
            key={i}
            index={i}
            points={points}
            duration={duration}
            getRect={getRect}
            onMovePoint={onMovePoint}
            onRemovePoint={onRemovePoint}
          />
        ) : (
          <div
            key={i}
            className="tl-marker tl-marker-preview"
            style={{ left: pct(secToRatio(p, duration)) }}
            aria-hidden="true"
            data-testid="timeline-marker-preview"
          >
            <span className="tl-marker-line" />
          </div>
        ),
      )}
    </div>
  );
});

/** 再生位置のつまみ。毎フレーム更新されるのはこの部品だけ。 */
const Playhead = memo(function Playhead({ duration, timeStore }: { duration: number; timeStore: Store<number> }) {
  const t = useStoreValue(timeStore);
  return (
    <div className="tl-playhead" style={{ left: pct(secToRatio(t, duration)) }} aria-hidden="true">
      <span className="tl-playhead-line" />
      <span className="tl-playhead-knob" />
    </div>
  );
});

export const Timeline = memo(function Timeline({
  duration,
  points,
  editable,
  timeStore,
  seek,
  onMovePoint,
  onRemovePoint,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [width, setWidth] = useState(0);
  const whole = useStoreValue(timeStore, (t) => Math.floor(t));

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const getRect = useCallback(() => trackRef.current?.getBoundingClientRect(), []);

  const seekFromPointer = (clientX: number) => {
    const r = getRect();
    if (r) seek(xToSec(clientX, r.left, r.width, duration));
  };

  return (
    <div className="timeline" data-testid="timeline-wrap">
      <div className="tl-body">
        <div
          ref={trackRef}
          className="tl-track"
          role="slider"
          tabIndex={0}
          aria-label="再生位置"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={whole}
          aria-valuetext={`${formatTime(whole)} / ${formatTime(duration)}`}
          data-testid="timeline"
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.focus({ preventScroll: true });
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromPointer(e.clientX);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            const cur = timeStore.get();
            let next: number | null = null;
            if (e.key === 'ArrowLeft') next = stepTime(cur, e.shiftKey ? -1 : -5, duration);
            else if (e.key === 'ArrowRight') next = stepTime(cur, e.shiftKey ? 1 : 5, duration);
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = duration;
            if (next !== null) {
              e.preventDefault();
              seek(next);
            }
          }}
        >
          <SegmentsLayer duration={duration} points={points} width={width} muted={!editable} />
        </div>
        <MarkersLayer
          duration={duration}
          points={points}
          editable={editable}
          getRect={getRect}
          onMovePoint={onMovePoint}
          onRemovePoint={onRemovePoint}
        />
        <Playhead duration={duration} timeStore={timeStore} />
      </div>
      <div className="tl-scale" aria-hidden="true">
        <span>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
});
