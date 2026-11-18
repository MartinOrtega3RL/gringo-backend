// Reglas puras del acceso al sistema (RF01 / RF02).

import { randomInt } from 'node:crypto'

// Sin letras ni números que se confunden al dictarlos o copiarlos a mano:
// ni 0/O, ni 1/l/I.
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * RF02.2 — contraseña provisoria para quien se olvidó la suya. La genera el
 * sistema, no la elige quien la restablece: así nadie la conoce de antes. Va en
 * dos grupos de cinco ("k7m3p-x9q2a") porque se dicta o se escribe en un papel.
 * @param {(max: number) => number} entero generador de enteros en [0, max)
 */
export const generarContrasenaProvisoria = (entero = randomInt) => {
  const grupo = () => Array.from({ length: 5 }, () => ALFABETO[entero(ALFABETO.length)]).join('')
  return `${grupo()}-${grupo()}`
}
