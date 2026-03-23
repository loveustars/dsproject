import { useRef, useCallback, useState } from 'react';

// Sentence boundary regex: split on Chinese/English punctuation
const SENTENCE_REGEX = /[^。！？!?.…\n]+[。！？!?.…\n]+/g;
// Minimum chars before we attempt TTS (avoid tiny fragments)
const MIN_CHUNK_LEN = 8;

interface TTSOptions {
  apiEndpoint: string;
  apiKey: string;
  voice?: string; // 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
  model?: string; // 'tts-1' | 'tts-1-hd'
  speed?: number;
}

interface QueueItem {
  index: number;
  audioBuffer: AudioBuffer;
}

export function useTTS(options: TTSOptions) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoadingTTS, setIsLoadingTTS] = useState(false);

  // Audio context (created lazily on user gesture)
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Ordered queue of decoded audio buffers waiting to play
  const queueRef = useRef<QueueItem[]>([]);
  // Index of the next chunk we expect to play
  const nextPlayIndexRef = useRef(0);
  // Index we assign to each TTS request
  const chunkIndexRef = useRef(0);
  // Is the audio player currently busy?
  const isPlayingRef = useRef(false);
  // Leftover text that doesn't end in punctuation yet
  const textBufferRef = useRef('');
  // Whether the stream has finished (so we can flush remainder)
  const streamDoneRef = useRef(false);
  // AbortController to cancel in-flight requests on stop
  const abortControllersRef = useRef<AbortController[]>([]);
  // Current source node (so we can stop it)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, []);

  // Try to play the next buffer in order
  const tryPlayNext = useCallback(() => {
    if (isPlayingRef.current) return;

    const expected = nextPlayIndexRef.current;
    const item = queueRef.current.find(q => q.index === expected);
    if (!item) {
      // Not arrived yet — will be triggered again when it arrives
      if (streamDoneRef.current && queueRef.current.length === 0 && chunkIndexRef.current === expected) {
        // All done
        setIsSpeaking(false);
        setIsLoadingTTS(false);
      }
      return;
    }

    // Remove from queue
    queueRef.current = queueRef.current.filter(q => q.index !== expected);
    isPlayingRef.current = true;
    setIsSpeaking(true);
    setIsLoadingTTS(false);

    const ctx = getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = item.audioBuffer;
    source.connect(ctx.destination);
    currentSourceRef.current = source;
    source.start(0);
    source.onended = () => {
      isPlayingRef.current = false;
      currentSourceRef.current = null;
      nextPlayIndexRef.current++;
      tryPlayNext();
    };
  }, [getAudioContext]);

  // Fetch TTS audio for a text chunk and push into queue
  const fetchTTS = useCallback(async (text: string, index: number) => {
    const cleanText = text.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (!cleanText) return;

    const controller = new AbortController();
    abortControllersRef.current.push(controller);

    try {
      const endpoint = options.apiEndpoint.replace(/\/$/, '');
      // Support both /v1 and bare base URLs
      const ttsUrl = endpoint.endsWith('/v1')
        ? `${endpoint}/audio/speech`
        : `${endpoint}/v1/audio/speech`;

      const res = await fetch(ttsUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { 'Authorization': `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model || 'tts-1',
          input: cleanText,
          voice: options.voice || 'nova',
          speed: options.speed || 1.0,
          response_format: 'mp3',
        }),
      });

      if (!res.ok) return;

      const arrayBuffer = await res.arrayBuffer();
      const ctx = getAudioContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      // Push in order
      queueRef.current.push({ index, audioBuffer });
      queueRef.current.sort((a, b) => a.index - b.index);

      tryPlayNext();
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('TTS chunk error:', err.message);
      }
      // Skip this chunk index so playback isn't stuck
      queueRef.current.push({ index, audioBuffer: new AudioBuffer({ length: 1, sampleRate: 24000 }) });
      tryPlayNext();
    }
  }, [options, getAudioContext, tryPlayNext]);

  // Call this for each text delta from the stream
  const pushTextDelta = useCallback((delta: string) => {
    textBufferRef.current += delta;

    // Extract complete sentences
    const sentences: string[] = [];
    let match;
    SENTENCE_REGEX.lastIndex = 0;
    while ((match = SENTENCE_REGEX.exec(textBufferRef.current)) !== null) {
      sentences.push(match[0]);
    }

    if (sentences.length > 0) {
      const lastMatch = sentences[sentences.length - 1];
      const lastIndex = textBufferRef.current.lastIndexOf(lastMatch) + lastMatch.length;
      textBufferRef.current = textBufferRef.current.slice(lastIndex);

      for (const sentence of sentences) {
        if (sentence.trim().length >= MIN_CHUNK_LEN) {
          const idx = chunkIndexRef.current++;
          fetchTTS(sentence, idx);
        }
      }
    }
  }, [fetchTTS]);

  // Call this when the stream finishes
  const flushRemaining = useCallback(() => {
    streamDoneRef.current = true;
    const remaining = textBufferRef.current.trim();
    if (remaining.length >= 1) {
      const idx = chunkIndexRef.current++;
      fetchTTS(remaining, idx);
    } else {
      // No remaining text — if nothing is queued/playing, mark done
      setTimeout(() => {
        if (!isPlayingRef.current && queueRef.current.length === 0) {
          setIsSpeaking(false);
          setIsLoadingTTS(false);
        }
      }, 200);
    }
    textBufferRef.current = '';
  }, [fetchTTS]);

  // Reset state for a new message
  const startSession = useCallback(() => {
    // Cancel any in-flight requests
    abortControllersRef.current.forEach(c => c.abort());
    abortControllersRef.current = [];

    // Stop current playback
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch {}
      currentSourceRef.current = null;
    }

    queueRef.current = [];
    nextPlayIndexRef.current = 0;
    chunkIndexRef.current = 0;
    isPlayingRef.current = false;
    textBufferRef.current = '';
    streamDoneRef.current = false;
    setIsSpeaking(false);
    setIsLoadingTTS(true);
  }, []);

  // Fully stop TTS (e.g. user presses stop)
  const stop = useCallback(() => {
    abortControllersRef.current.forEach(c => c.abort());
    abortControllersRef.current = [];

    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch {}
      currentSourceRef.current = null;
    }

    queueRef.current = [];
    isPlayingRef.current = false;
    textBufferRef.current = '';
    streamDoneRef.current = true;
    setIsSpeaking(false);
    setIsLoadingTTS(false);
  }, []);

  return {
    pushTextDelta,
    flushRemaining,
    startSession,
    stop,
    isSpeaking,
    isLoadingTTS,
  };
}