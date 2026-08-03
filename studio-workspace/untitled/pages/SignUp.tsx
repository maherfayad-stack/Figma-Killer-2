import styles from './SignUp.module.css'
import { Button, TextInput } from '@alm-design/design-system'

export default function SignUp() {
  return (
    <main className="" style={{ display: "flex", flexDirection: "column", gap: "var(--space)", width: "100%", maxWidth: "393px", marginInline: "auto", padding: "var(--space)", background: "var(--background-base-default)", minHeight: "800px", boxSizing: "border-box", fontFamily: "Open Sans, system-ui, sans-serif" }}>
      <button type="button" aria-label="Back" style={{ width: "40px", height: "40px", border: "none", background: "transparent", color: "var(--icon-secondary-default)", fontSize: "24px", cursor: "pointer", padding: "0", alignSelf: "flex-start" }}>‹</button>
      <h1 style={{ fontSize: "var(--type-headline-size)", fontWeight: "var(--type-headline-weight)", lineHeight: "var(--type-headline-lh)", letterSpacing: "var(--type-headline-ls)", color: "var(--text-base-default)", margin: "0" }}>Sign in or create account</h1>
      <div style={{ display: "flex", gap: "var(--space-sm)" }}>
        <TextInput label="Code" dropdown />
        <TextInput label="Mobile number" required />
      </div>
      <Button variant="primary" label="Continue">
      </Button>
      <a href="#" style={{ color: "var(--text-link-default)", textDecoration: "none", fontWeight: "600", textAlign: "center", fontSize: "14px" }}>Register as a Business</a>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space)", marginBlock: "var(--space-lg)" }}>
        <hr style={{ flex: "1", border: "none", borderTop: "1px solid var(--border-base-default)", height: "0" }} />
        <span style={{ color: "var(--text-base-subtext)", fontSize: "var(--type-caption-size)" }}>OR</span>
        <hr style={{ flex: "1", border: "none", borderTop: "1px solid var(--border-base-default)", height: "0" }} />
      </div>
      <Button variant="primary-inverted" label="Continue with email" />
      <Button variant="primary-inverted" label="Continue with Apple" />
      <Button variant="primary-inverted" label="Continue with Google" />
    </main>
  )
}
