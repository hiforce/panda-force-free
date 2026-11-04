export const MIN_ADMINISTRATOR_PASSWORD_LENGTH = 6;
export const MAX_ADMINISTRATOR_PASSWORD_LENGTH = 256;
export const ADMINISTRATOR_PASSWORD_ERROR =
  "Password must be 6–256 characters and include uppercase and lowercase letters and a number.";

export function validAdministratorPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= MIN_ADMINISTRATOR_PASSWORD_LENGTH &&
    password.length <= MAX_ADMINISTRATOR_PASSWORD_LENGTH &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}
