// Portada de entrada (2026-10-06, pedido por Francisco): solo presentacion,
// sin usuario ni contrasena. En GitHub Pages un acceso con contrasena hecho
// en el navegador no protegeria nada (el codigo y los datos son publicos); un
// acceso de verdad necesita un servidor que lo compruebe, y queda como idea
// aparte.
//
// Se muestra una vez por pestana (sessionStorage): al recargar mientras se
// trabaja no vuelve a salir. Se carga justo despues del bloque #portada en
// index.html (y de config.js), antes que el resto, para no ensenarla un
// instante si ya se vio.
(function () {
  // "Version piloto" / "Version avanzada" en la portada y en el pie del mapa,
  // segun el modo (config.js).
  const versionNombre = APP_MODE === "completo" ? "Versión avanzada" : "Versión piloto";
  const ponerVersion = () => {
    document.querySelectorAll(".version-nombre").forEach((el) => {
      el.textContent = versionNombre;
    });
  };
  // Ya (la portada) y al terminar de leer la pagina (el pie del mapa esta mas
  // abajo en index.html y aun no existe al cargar este script).
  ponerVersion();
  document.addEventListener("DOMContentLoaded", ponerVersion);

  const portada = document.getElementById("portada");
  const boton = document.getElementById("portada-entrar");
  let vista = false;
  try {
    vista = sessionStorage.getItem("portadaVista") === "1";
  } catch (e) {
    // Almacenamiento bloqueado (navegacion privada estricta): se muestra.
  }
  if (vista) {
    portada.hidden = true;
    return;
  }
  const entrar = () => {
    try {
      sessionStorage.setItem("portadaVista", "1");
    } catch (e) {
      // sin almacenamiento: volvera a salir al recargar, nada mas
    }
    portada.classList.add("portada-saliendo");
    setTimeout(() => {
      portada.hidden = true;
    }, 350);
  };
  boton.addEventListener("click", entrar);
  portada.addEventListener("keydown", (e) => {
    if (e.key === "Escape") entrar();
  });
  boton.focus();
})();
