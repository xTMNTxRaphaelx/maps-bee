#!/bin/sh
# Widened address-shape study across four cities.
#
#   1. cuts the Berlin and Nairobi extracts if they are not already there
#   2. builds the city gazetteer for each
#   3. reverse geocodes the committed candidate points with Nominatim
#   4. scores the three address shapes and writes results/address-shapes.txt
#
# Nominatim allows one request a second for automated use. scripts/fetch-nominatim.js sleeps
# 1100 ms between requests; do not run two copies of this at once. A city whose fixture already
# exists is skipped, so re-running does not refetch.
#
# The optional contact goes in the User-Agent, which is what Nominatim's policy asks for so they
# can reach whoever is running a misbehaving client. Pass a URL or an email if you want to give
# one; leave it off and the User-Agent names the application only.
#
# usage: sh scripts/address-study.sh [contact]
set -e

B=node_modules/bare-runtime/bin/bare
S=https://build.protomaps.com/20261012.pmtiles
CONTACT="$1"
OUT=results/address-shapes.txt
CITIES="jaipur lugano berlin nairobi"

bbox () {
  case "$1" in
    jaipur)  echo "75.65,26.75,75.95,27.05" ;;
    lugano)  echo "8.85,45.95,9.05,46.06" ;;
    berlin)  echo "13.30,52.45,13.55,52.56" ;;
    nairobi) echo "36.70,-1.36,36.95,-1.22" ;;
  esac
}

gaz () {
  case "$1" in
    jaipur) echo "data/gazetteer.json" ;;
    lugano) echo "data/gazetteer-lugano.json" ;;
    *)      echo "data/gazetteer-$1.json" ;;
  esac
}

[ -x "$B" ] || { echo "$B missing; run npm install" >&2; exit 1; }

# only needed when an extract has to be cut; tools/ is gitignored, so a fresh clone has no binary
need_pmtiles () {
  if [ -x tools/pmtiles ]; then
    return 0
  fi
  cat >&2 <<'EOF'
tools/pmtiles is missing and an extract still has to be cut.

  mkdir -p tools
  # arm64 Macs; use Darwin_x86_64 on Intel
  curl -L -o /tmp/pmtiles.zip https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_arm64.zip
  unzip -o -j /tmp/pmtiles.zip pmtiles -d tools
  chmod +x tools/pmtiles
  xattr -d com.apple.quarantine tools/pmtiles 2>/dev/null
  ./tools/pmtiles version

Already have the binary elsewhere? Copy or symlink it in:  ln -s /path/to/pmtiles tools/pmtiles
EOF
  exit 1
}
command -v node >/dev/null || { echo "node is needed for the Nominatim fetch" >&2; exit 1; }
mkdir -p results

echo "== 1/3 extracts and gazetteers =="
for C in berlin nairobi; do
  BB=$(bbox "$C")
  if [ -f "data/extract/$C-z11-14.pmtiles" ]; then echo "  have $C z11-14"; else
    need_pmtiles
    echo "  cutting $C z11-14"
    ./tools/pmtiles -q extract "$S" "data/extract/$C-z11-14.pmtiles" --bbox="$BB" --minzoom=11 --maxzoom=14
  fi
  if [ -f "data/extract/$C-z15.pmtiles" ]; then echo "  have $C z15"; else
    need_pmtiles
    echo "  cutting $C z15"
    ./tools/pmtiles -q extract "$S" "data/extract/$C-z15.pmtiles" --bbox="$BB" --minzoom=15 --maxzoom=15
  fi
  if [ -f "data/extract/$C-z10.pmtiles" ]; then echo "  have $C z10"; else
    need_pmtiles
    echo "  cutting $C z10"
    ./tools/pmtiles -q extract "$S" "data/extract/$C-z10.pmtiles" --bbox="$BB" --maxzoom=10
  fi
  G=$(gaz "$C")
  if [ -f "$G" ]; then echo "  have $G"; else
    echo "  building $G"
    $B scripts/gazetteer.js "$G" --kinds=city,town "data/extract/$C-z10.pmtiles" "$BB" 0 10 >/dev/null
  fi
done

echo "== 2/3 Nominatim, 1 request a second =="
for C in $CITIES; do
  F="test/fixtures/$C-nominatim-wide.json"
  if [ -f "$F" ]; then
    echo "  have $F (delete it to refetch)"
    continue
  fi
  N=$(grep -c '"lat"' "test/fixtures/$C-candidates.json")
  echo "  $C: $N points, about $((N * 11 / 10)) s"
  node scripts/fetch-nominatim.js "test/fixtures/$C-candidates.json" "$F" "$CONTACT"
done

echo "== 3/3 scoring =="
{
  echo "# address shapes, $(date -u +%Y-%m-%dT%H:%M:%SZ), protomaps build 20261012"
  echo "# A z14 2x2 + z15 pin | B z15 2x2 + gazetteer areas | C z15 2x2 only"
  echo
} > "$OUT"
for C in $CITIES; do
  $B scripts/address-shapes.js "test/fixtures/$C-nominatim-wide.json" \
    "data/extract/$C-z11-14.pmtiles" "data/extract/$C-z15.pmtiles" "$(bbox "$C")" "$(gaz "$C")" >> "$OUT"
  echo >> "$OUT"
done

cat "$OUT"
echo "wrote $OUT  — send this file back"
