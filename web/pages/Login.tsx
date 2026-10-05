import { useState } from "react";
import { api } from "../lib/api";
import "./pages.css";

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { body: { password } });
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark large">F</div>
        <h1>FRAME Studio</h1>
        <input className="input" type="password" autoFocus placeholder="密码" value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" disabled={busy || !password}>
          登录
        </button>
      </form>
    </div>
  );
}
