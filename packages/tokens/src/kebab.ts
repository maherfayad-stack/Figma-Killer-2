/**
 * camelCase → kebab-case, matching the convention already used by the hand
 * -written `design-system/src/tokens/*.css` files (`aqua100` -> `aqua-100`,
 * `whiteStatic` -> `white-static`, `cardGap` -> `card-gap`, `2xs` -> `2xs`
 * unchanged since it doesn't start with a letter-then-digit boundary).
 */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .toLowerCase();
}
