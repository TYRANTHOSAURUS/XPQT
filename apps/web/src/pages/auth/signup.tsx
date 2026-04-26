import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '@/providers/auth-provider';
import { apiFetch } from '@/lib/api';
import { TenantLogo } from '@/components/tenant-logo';

export function SignUpPage() {
  const navigate = useNavigate();
  const { signUp } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: signUpError } = await signUp(email, password);

      if (signUpError) {
        setError(signUpError);
        setLoading(false);
        return;
      }

      try {
        await apiFetch('/persons', {
          method: 'POST',
          body: JSON.stringify({
            first_name: firstName,
            last_name: lastName,
            email,
          }),
        });
      } catch {
        // Person creation may fail if API is not available or record already exists.
        // The user was still created in Supabase Auth, so we proceed.
      }

      navigate('/login?message=Account created. Please sign in.', { replace: true });
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link to="/" className="flex items-center gap-2 font-medium">
            <div className="flex h-8 w-8 items-center justify-center">
              <TenantLogo variant="mark" alt="Prequest" className="h-7 w-7" />
            </div>
            Prequest
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <form onSubmit={handleSubmit} className={cn('flex flex-col gap-6')}>
              <FieldGroup>
                <div className="flex flex-col items-center gap-1 text-center">
                  <h1 className="text-2xl font-bold">Create an account</h1>
                  <p className="text-sm text-balance text-muted-foreground">
                    Enter your details to get started
                  </p>
                </div>

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="first-name">First name</FieldLabel>
                    <Input
                      id="first-name"
                      placeholder="Jane"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      autoComplete="given-name"
                      autoFocus
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="last-name">Last name</FieldLabel>
                    <Input
                      id="last-name"
                      placeholder="Doe"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      autoComplete="family-name"
                    />
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                  />
                </Field>

                <Field>
                  <Button type="submit" disabled={loading} className="w-full">
                    {loading ? 'Creating account...' : 'Create account'}
                  </Button>
                </Field>
                <FieldSeparator>Or</FieldSeparator>
                <FieldDescription className="text-center">
                  Already have an account?{' '}
                  <Link to="/login" className="underline underline-offset-4">
                    Sign in
                  </Link>
                </FieldDescription>
              </FieldGroup>
            </form>
          </div>
        </div>
      </div>

      {/* Right: branding image */}
      <div className="relative hidden overflow-hidden bg-muted lg:block">
        <img
          src="/assets/login-background.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />
        <div className="absolute inset-x-0 bottom-0 px-12 pb-16">
          <h2 className="text-3xl font-bold tracking-tight text-white text-balance">
            A system that unifies the workplace
          </h2>
        </div>
      </div>
    </div>
  );
}
