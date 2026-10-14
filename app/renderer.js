'use strict'
const $ = (id) => document.getElementById(id)

function append (text) {
  const log = $('log')
  log.textContent += (log.textContent ? '\n' : '') + text
}

function coordinate (id) {
  const s = $(id).value.trim()
  if (s === '') throw new Error(` is empty`)
  return Number(s)
}

for (const b of document.querySelectorAll('[data-lat]')) {
  b.addEventListener('click', () => {
    $('lat').value = b.dataset.lat
    $('lon').value = b.dataset.lon
  })
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true
  try {
    const r = await window.maps.run({
      key: $('key').value.trim(),
      lat: coordinate('lat'),
      lon: coordinate('lon'),
      prefetch: $('prefetch').checked
    })
    $('thumb').innerHTML = r.svg || ''
    $('label').textContent = r.label
    $('address').textContent = r.address ? r.address.display : 'null'
    append(r.lines.join('\n'))
  } catch (err) {
    append(`error\t${err.message}`)
  } finally {
    $('run').disabled = false
  }
})

$('copy').addEventListener('click', () => window.maps.copy($('log').textContent))
