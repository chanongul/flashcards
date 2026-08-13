'use client';

import { useEffect, useRef, useState } from 'react';

/** Records from the mic via MediaRecorder, handing the finished Blob to
 * `onDone` once stopped — used by TiptapFieldInput's inline "insert audio"
 * flow. Kept as its own hook (not inlined there) so the recording logic
 * and its cleanup-on-unmount (stopping a stray open mic stream) lives in
 * one place, independent of whatever calls it. */
export function useAudioRecorder(onDone: (blob: Blob) => void, maxBytes: number) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function saveBlob(blob: Blob) {
    if (blob.size > maxBytes) {
      setError(`Audio is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`);
      return;
    }
    setError('');
    onDone(blob);
  }

  async function start() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        saveBlob(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Microphone access was denied or unavailable.');
    }
  }

  function stop() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }

  return { recording, error, start, stop, saveBlob };
}
