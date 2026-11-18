// Preguntas por consola para los scripts que se corren en el servidor
// (crear-soporte, restablecer-contrasena).

// UNA sola interfaz para toda la tanda de preguntas, y creada recien cuando se
// va a preguntar.
//
// Dos motivos. Cerrar una interfaz cierra process.stdin, asi que si se creara
// una por pregunta, la segunda leeria una entrada ya terminada: question() no
// dispara nunca y el proceso se cuelga sin decir nada. Y crearla antes de
// hablar con la base la deja consumiendo stdin durante las consultas, de modo
// que lo que llegue en ese rato se descarta sin que nadie lo pida.
export const preguntar = async (lector, consigna) => (await lector.question(consigna)).trim()

// Oculta lo que se tipea sin ocultar la consigna. Se interviene el metodo
// interno de readline y no process.stdout.write: parchear la salida entera
// tambien se traga el texto de la pregunta, y el usuario no ve que se le pide.
// _writeToOutput es API privada de Node, estable desde hace anos; es la forma
// habitual de enmascarar en readline sin sumar una dependencia por un script
// que se corre una vez.
export const preguntarOculto = async (lector, consigna) => {
  const original = lector._writeToOutput

  lector._writeToOutput = (texto) => {
    if (texto.includes(consigna)) return original.call(lector, texto)
    // Un asterisco por caracter tipeado; los saltos de linea pasan enteros.
    return original.call(lector, texto.includes('\n') ? texto : '*')
  }

  try {
    return (await lector.question(consigna)).trim()
  } finally {
    lector._writeToOutput = original
    process.stdout.write('\n')
  }
}

export class Abortar extends Error {}
export const abortar = (mensaje) => { throw new Abortar(mensaje) }
