/**
 * La página que abre el enlace de subida. Es una sola pieza sin dependencias. Antes de enviar, el navegador convierte cada
 * foto a JPG de hasta 2000×2000 (lo que pide la app), así sirven las fotos tal como salen del celular.
 */
export function paginaDeSubida(nonce: string): string {
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Subir fotos · Synkro</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px 16px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 460px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  p { margin: 8px 0; line-height: 1.4; }
  .suave { opacity: .7; font-size: .9rem; }
  label.elegir, button { display: block; box-sizing: border-box; width: 100%; padding: 14px; border-radius: 12px; font-size: 1rem; text-align: center; cursor: pointer; }
  label.elegir { border: 2px dashed #b9941f; margin: 16px 0; }
  button { border: 0; background: #FCCB34; color: #111; font-weight: 600; }
  button:disabled { opacity: .45; cursor: default; }
  input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; }
  ul { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  li { position: relative; }
  li img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; display: block; }
  li span { display: block; font-size: .7rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  li button { position: absolute; top: 4px; right: 4px; width: 28px; padding: 2px; border-radius: 50%; background: #111; color: #fff; }
  #aviso { font-weight: 600; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Subir fotos</h1>
  <p id="tienda" class="suave">Comprobando el enlace…</p>
  <div id="formulario" hidden>
    <label class="elegir">Elegir o tomar fotos<input id="archivos" type="file" accept="image/*" multiple></label>
    <ul id="lista"></ul>
    <button id="subir" disabled>Subir fotos</button>
    <p class="suave">El nombre de cada archivo ayuda al asistente a saber qué foto es de qué color o variante.</p>
  </div>
  <p id="aviso" role="status"></p>
</main>
<script nonce="${nonce}">
(function () {
  var token = location.hash.slice(1);
  var fotos = [];
  var maximo = 30;
  var $ = function (id) { return document.getElementById(id); };
  var avisar = function (t) { $('aviso').textContent = t; };
  var cabeceras = { Authorization: 'Bearer ' + token };

  fetch('subir-fotos/estado', { headers: cabeceras }).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) throw new Error(d.message);
      maximo = d.maximo;
      $('tienda').textContent = 'Para la tienda «' + d.tienda + '» · hasta ' + maximo + ' fotos';
      $('formulario').hidden = false;
    });
  }).catch(function (e) { $('tienda').textContent = ''; avisar(e.message || 'No se pudo comprobar el enlace.'); });

  function convertir(archivo) {
    return new Promise(function (listo, fallo) {
      var direccion = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        var escala = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        var lienzo = document.createElement('canvas');
        lienzo.width = Math.round(img.naturalWidth * escala);
        lienzo.height = Math.round(img.naturalHeight * escala);
        var c = lienzo.getContext('2d');
        c.fillStyle = '#fff';
        c.fillRect(0, 0, lienzo.width, lienzo.height);
        c.drawImage(img, 0, 0, lienzo.width, lienzo.height);
        URL.revokeObjectURL(direccion);
        lienzo.toBlob(function (b) { b ? listo(b) : fallo(); }, 'image/jpeg', 0.9);
      };
      img.onerror = function () { URL.revokeObjectURL(direccion); fallo(); };
      img.src = direccion;
    });
  }

  function pintar() {
    var lista = $('lista');
    lista.textContent = '';
    fotos.forEach(function (f, i) {
      var li = document.createElement('li');
      var img = document.createElement('img');
      img.src = f.vista;
      img.alt = f.nombre;
      var nombre = document.createElement('span');
      nombre.textContent = f.nombre;
      var quitar = document.createElement('button');
      quitar.type = 'button';
      quitar.textContent = '×';
      quitar.setAttribute('aria-label', 'Quitar ' + f.nombre);
      quitar.onclick = function () { URL.revokeObjectURL(f.vista); fotos.splice(i, 1); pintar(); };
      li.append(img, quitar, nombre);
      lista.append(li);
    });
    $('subir').disabled = !fotos.length;
    $('subir').textContent = fotos.length ? 'Subir ' + fotos.length + (fotos.length === 1 ? ' foto' : ' fotos') : 'Subir fotos';
  }

  $('archivos').onchange = function (e) {
    var elegidos = Array.prototype.slice.call(e.target.files);
    e.target.value = '';
    avisar('Preparando…');
    var fallidas = [];
    elegidos.reduce(function (antes, archivo) {
      return antes.then(function () {
        if (fotos.length >= maximo) return;
        return convertir(archivo).then(function (jpg) {
          fotos.push({ blob: jpg, nombre: archivo.name, vista: URL.createObjectURL(jpg) });
          pintar();
        }, function () { fallidas.push(archivo.name); });
      });
    }, Promise.resolve()).then(function () {
      avisar(fallidas.length ? 'No se pudieron abrir: ' + fallidas.join(', ') : '');
    });
  };

  $('subir').onclick = function () {
    var datos = new FormData();
    fotos.forEach(function (f) { datos.append('images', f.blob, f.nombre.replace(/\\.[^.]*$/, '') + '.jpg'); });
    $('subir').disabled = true;
    avisar('Subiendo…');
    fetch('subir-fotos', { method: 'POST', headers: cabeceras, body: datos }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.message);
        $('formulario').hidden = true;
        $('tienda').textContent = '';
        avisar('Listo: ' + d.subidas + (d.subidas === 1 ? ' foto subida' : ' fotos subidas') + '. Vuelve al chat y dile a tu asistente que ya terminaste.');
      });
    }).catch(function (e) {
      $('subir').disabled = false;
      avisar(e.message || 'No se pudo subir. Revisa tu conexión e inténtalo de nuevo.');
    });
  };
})();
</script>
</body>
</html>`;
}
