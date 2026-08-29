import Link from 'next/link';
import { LogIn, LogOut } from 'lucide-react';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { buttonVariants } from '@/components/ui/button';
import { Button } from '@/components/ui/button';

export async function AuthStatus() {
  let email: string | undefined;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    email = user?.email;
  } catch {
    email = undefined;
  }

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          InfraGenie
        </Link>
        {email ? (
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-sm text-muted-foreground">{email}</span>
            <form action="/auth/logout" method="post">
              <Button type="submit" variant="outline" size="sm">
                <LogOut className="size-4" aria-hidden />
                Sign out
              </Button>
            </form>
          </div>
        ) : (
          <Link href="/auth/login" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <LogIn className="size-4" aria-hidden />
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
