// Client-side, PREVIEW-ONLY trim — decodes, slices, and re-encodes to a
// plain WAV purely so the *local* blob: preview's own native <audio>
// element reports a genuinely short duration (and so its scrub bar spans
// just that range) while a clip is being edited, before it's ever been
// uploaded. This is deliberately narrow, not a general audio-editing
// feature: the real cut always happens server-side, in the same ffmpeg
// pass app/api/media/upload/audio/route.ts already runs — re-encoding
// audio ourselves, for real, was explicitly the thing worth avoiding (see
// that route's own doc comment). This is mechanical PCM + a 44-byte WAV
// header, nothing codec-related, and the result is only ever used for a
// temporary local preview nobody else ever sees or stores.
//
// (Tried first: appending a Media Fragments URI, `#t=start,end`, to the
// blob: URL — the standard, zero-code way browsers are *supposed* to
// treat a resource as if it were just that sub-range. Confirmed
// empirically that Chromium doesn't honor it for blob: sources at all —
// `audio.duration` still reported the full original length — so this
// actual re-encode is the only remaining option for the scrub bar/duration
// display to be correct, not just playback itself.)
export async function trimAudioBlobForPreview(blob: Blob, start: number, end: number): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const sampleRate = decoded.sampleRate;
    const startSample = Math.max(0, Math.floor(start * sampleRate));
    const endSample = Math.min(decoded.length, Math.ceil(end * sampleRate));
    const frameCount = Math.max(0, endSample - startSample);
    const channelData: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      channelData.push(decoded.getChannelData(c).slice(startSample, endSample));
    }
    return encodeWav(channelData, sampleRate, frameCount);
  } finally {
    void audioCtx.close();
  }
}

function encodeWav(channelData: Float32Array[], sampleRate: number, frameCount: number): Blob {
  const numChannels = Math.max(1, channelData.length);
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c]?.[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
