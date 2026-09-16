import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

// Face ID / Touch ID / empremta are all "platform" authenticators — the
// only ones relevant here, since a coach isn't going to carry a separate
// security key. Feature-detected up front so the biometric button never
// shows on a device/browser that couldn't complete the ceremony anyway.
export async function passkeysAvailable(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false;
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

export async function registerPasskey(token: string, deviceLabel?: string): Promise<void> {
  const options = await api.webauthnRegisterOptions(token);
  const response = await startRegistration({ optionsJSON: options });
  await api.webauthnRegisterVerify(token, response, deviceLabel);
}

export async function loginWithPasskey(email: string): Promise<string> {
  const options = await api.webauthnLoginOptions(email);
  const response = await startAuthentication({ optionsJSON: options });
  const session = await api.webauthnLoginVerify(email, response);
  return session.token;
}
