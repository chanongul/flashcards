'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setStatus('error');
    } else {
      router.replace('/');
    }
  }

  return (
    <main className="mx-auto mb-2 max-w-sm p-6 sm:mb-0">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          className="w-full rounded-md bg-neutral-100 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {status === 'sending' ? 'Signing in…' : 'Sign in'}
        </button>
        {status === 'error' && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </main>
  );
}
