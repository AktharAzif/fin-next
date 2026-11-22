// The "or" rule between two ways to do one thing (AdminSignIn, AdminSecondFactor, AdminStepUp): a
// hairline, the word, a hairline. Decorative: each way has its own named control.
export function OrDivider() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-caption text-text-tertiary">or</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
