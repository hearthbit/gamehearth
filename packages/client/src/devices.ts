import type { GameInfo, RoleInfo } from "./protocol";
import { texts } from "./texts";

export type ScreenClass = "small" | "medium" | "large";

export interface Device {
  screen: ScreenClass;
  touch: boolean;
  pointer: boolean;
}

const screenRank: Record<ScreenClass, number> = { small: 0, medium: 1, large: 2 };

function matches(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

export function currentDevice(): Device {
  return {
    screen: matches("(min-width: 1100px)") ? "large" : matches("(min-width: 700px)") ? "medium" : "small",
    touch: matches("(any-pointer: coarse)"),
    pointer: matches("(any-pointer: fine)"),
  };
}

export function fitsRole(role: RoleInfo, device: Device): boolean {
  if (screenRank[device.screen] < screenRank[role.screen]) {
    return false;
  }
  if (role.inputs.length === 0) {
    return true;
  }
  return role.inputs.some((input) =>
    input === "touch" ? device.touch : input === "mouse" || input === "keyboard" ? device.pointer : input === "gamepad",
  );
}

export function fitsGame(game: GameInfo, device: Device): boolean {
  const roles = Object.values(game.roles ?? {}).filter((role): role is RoleInfo => role !== undefined);
  return roles.length === 0 || roles.some((role) => fitsRole(role, device));
}

export function deviceLabel(game: Pick<GameInfo, "roles">): string | undefined {
  const roles = game.roles ?? {};
  if (roles.screen !== undefined) {
    if (roles.player === undefined) {
      return texts.devicesScreenAndPhones;
    }
    return roles.screen.optional === true ? texts.devicesOwnScreenOptional : texts.devicesScreenAndOwn;
  }
  return roles.player !== undefined || roles.controller !== undefined ? texts.devicesOwn : undefined;
}
