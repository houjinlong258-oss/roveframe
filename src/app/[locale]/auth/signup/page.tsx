'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSession } from '@/hooks/use-session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INDUSTRIES = [
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'retail', label: 'Retail' },
  { value: 'beauty', label: 'Beauty' },
  { value: 'service', label: 'Service' },
];

export default function SignupPage() {
  const router = useRouter();
  const t = useTranslations('auth');
  const { session, signup } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [industry, setIndustry] = useState('restaurant');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await signup(email, password, businessName, industry);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.replace('/');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t('signupTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('signupSubtitle')}</p>
        <div className="space-y-2">
          <Label htmlFor="email">{t('email')}</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('password')}</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="business_name">{t('businessName')}</Label>
          <Input
            id="business_name"
            type="text"
            required
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="industry">{t('industry')}</Label>
          <select
            id="industry"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {INDUSTRIES.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? t('submitting') : t('signup')}
        </Button>
        <p className="text-sm text-muted-foreground text-center">
          {t('haveAccount')}{' '}
          <a href="/auth/login" className="underline text-primary">
            {t('loginLink')}
          </a>
        </p>
      </form>
    </div>
  );
}
