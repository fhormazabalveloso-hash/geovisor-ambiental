# Pipeline de conversión de datos

Convierte el catálogo nacional (SHP/GPKG/GeoJSON, distintos CRS, en
`data-raw` externo) a teselas vectoriales **PMTiles en EPSG:4326**, listas
para `data-web/` y el visor MapLibre. Ver decisión de arquitectura en
`README.md` §2/§3 del proyecto.

## Cómo funciona

Sin `tippecanoe` ni WSL ni Node: todo con herramientas ya disponibles en el
entorno `miniforge3` (`ogr2ogr` de GDAL) más el paquete `pmtiles` de Python.

Por cada capa de `config.yaml`:

1. **Reproyección** a EPSG:4326 con `ogr2ogr` (una sola fuente) o fusión de
   varias fuentes con `geopandas` + reproyección (cuando la capa está
   partida en varios ficheros, p. ej. peninsula/Canarias o por provincia).
2. **Teselado**: `ogr2ogr -f MVT` - el driver MVT de GDAL genera el árbol de
   teselas (`z/x/y.pbf`) directamente, sin tippecanoe.
3. **Empaquetado**: `pmtiles.convert.disk_to_pmtiles()` empaqueta el árbol
   en un único `.pmtiles` - formato de un archivo, servible por HTTP range
   requests desde GitHub Pages (sin servidor de teselas).

## Requisitos

Entorno `miniforge3` (`base`), ya cumplidos en este equipo:

```
pip install pmtiles pyyaml
```

`ogr2ogr` / GDAL vienen con miniforge3 (`Library\bin\ogr2ogr.exe`).
`geopandas` / `pyogrio` también ya están instalados.

## Uso

```powershell
python pipeline\build_tiles.py --list              # lista las capas del catálogo
python pipeline\build_tiles.py --only hic,iba       # construye solo estas capas
python pipeline\build_tiles.py                      # construye TODO el catálogo
```

La salida va a `data-web/<id>.pmtiles`. Si un `.pmtiles` supera ~90 MB, el
script avisa: Git/GitHub tienen límite duro de 100 MB por archivo - hay que
subir `maxzoom` hacia abajo, simplificar geometría, o (si no queda otra)
usar Git LFS / GitHub Releases para ese archivo en vez de commitearlo
directo. Esto es más probable en las capas grandes (ver siguiente sección).

## Capas grandes - aparte

Cinco capas parten de shapefiles de 1-1.9 GB (inundabilidad T10/T100/T500,
DPH cartográfico probable, montes de utilidad pública). El teselado a
resoluciones altas (`z > 9`) es lento - `pmtiles` incluso avisa
`"Large tilesets (z > 9) require extreme processing times"`. Se han
configurado con `maxzoom` reducido (12-13) precisamente por esto, pero aun
así conviene construirlas aparte / sin prisa, no en la tanda rápida:

```powershell
python pipeline\build_tiles.py --only dph_cartografico_probable,laminas_inundacion_t10,laminas_inundacion_t100,laminas_inundacion_t500,montes_utilidad_publica
```

## Notas

- `config.yaml` tiene comentarios `# revisar:` en las capas donde inferí el
  significado de un fichero por su nombre (p. ej. sufijos `_c`/`_p`/`_pb`,
  prefijos `A_`/`Ca_`/`M_`) sin metadato que lo confirme. Revisar antes de
  dar el catálogo por definitivo.
- La capa `vegetacion_so` (Vegetación 10 SE/SO) se dejó fuera: no está en
  el catálogo del README y solo cubre 2 hojas regionales, no toda España.
- El pipeline lee directamente de la carpeta de Cristian en OneDrive
  (`data_raw_root` en `config.yaml`) - no se copian los datos en bruto
  dentro del repo, para no duplicar los ~8 GB del catálogo.
