// Phase 0's NullIdentityProvider has been superseded by LocalIdentityProvider
// in Phase 1. This file is retained as a placeholder to avoid stale imports;
// new code should depend on IdentityProvider (the abstract class) and let the
// identity module's factory pick the right impl at boot.

export {};
