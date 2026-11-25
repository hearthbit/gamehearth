import { useState } from "preact/hooks";
import { ApiError, login } from "../api";
import type { Me } from "../protocol";
import { errorText, texts } from "../texts";
import type { Notify } from "./toasts";

export function LoginForm({ notify, onDone, initialUsername = "", idPrefix = "login" }: { notify: Notify; onDone: (user: Me) => void; initialUsername?: string; idPrefix?: string }) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (username.trim() === "" || password === "") {
      return;
    }
    setBusy(true);
    try {
      const user = await login(username.trim(), password);
      setPassword("");
      onDone(user);
    } catch (error) {
      notify(error instanceof ApiError ? errorText(error.code, error.message) : texts.unknownError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack" onSubmit={submit}>
      <div class="field">
        <label for={`${idPrefix}-username`}>{texts.username}</label>
        <input
          id={`${idPrefix}-username`}
          class="input"
          value={username}
          maxLength={32}
          autoComplete="username"
          autoCapitalize="none"
          spellcheck={false}
          onInput={(event) => setUsername(event.currentTarget.value)}
        />
      </div>
      <div class="field">
        <label for={`${idPrefix}-password`}>{texts.password}</label>
        <input
          id={`${idPrefix}-password`}
          class="input"
          type="password"
          value={password}
          maxLength={200}
          autoComplete="current-password"
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </div>
      <button type="submit" class="button block" disabled={busy || username.trim() === "" || password === ""}>
        {texts.signIn}
      </button>
    </form>
  );
}
