////////////////////////////////////////////////////////////////////////////////

const [
  loadRemoteBtn,
  remoteUrl,
  dragTarget,
  uploadFiles,
  loadExample,
  promptText,
  errorText,
  // toolbar,
  // statusBar,
  // progressBarOverlay,
  // progressBar,
  originalStatus,
  generatedStatus,
] = [
  '#loadRemote',
  '#remoteUrl',
  '#dragTarget',
  '#uploadFiles',
  '#loadExample',
  '#promptText',
  '#errorText',
  // '#toolbar',
  // '#statusBar',
  // '#progressBar',
  // '#progressBar .progress',
  '#originalStatus',
  '#generatedStatus',
].map(document.querySelector.bind(document))

let dragging = 0
let filesInput

const isFilesDragEvent = e =>
  e.dataTransfer?.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1

////////////////////////////////////////////////////////////////////////////////

document.ondragover = e => e.preventDefault()

document.ondragenter = e => {
  e.preventDefault()
  if (!isFilesDragEvent(e)) return
  dragTarget.style.display = 'block'
  dragging++
}

document.ondragleave = e => {
  e.preventDefault()
  if (!isFilesDragEvent(e)) return
  if (--dragging === 0) dragTarget.style.display = 'none'
}

document.ondrop = e => {
  e.preventDefault()
  dragTarget.style.display = 'none'
  dragging = 0
  if (e.dataTransfer?.files) startLoading(e.dataTransfer.files)
}

uploadFiles.onclick = () => {
  if (filesInput) document.body.removeChild(filesInput)
  filesInput = document.createElement('input')
  filesInput.type = 'file'
  filesInput.multiple = true
  filesInput.style.display = 'none'
  document.body.appendChild(filesInput)
  filesInput.click()
  filesInput.onchange = () => startLoading(filesInput.files)
}

loadRemoteBtn.onclick = async () => {
  const url = remoteUrl?.value
  if (!url) return
  window.location.search = `?url=${url}`
  const code = await fetch(url).then(r => r.text())
  return finishLoading('', code)
}

// Add paste handler for remoteUrl input
remoteUrl.addEventListener('paste', e => {
  const url = e.clipboardData.getData('text/plain')
  e.target.value = url
  e.preventDefault()
})

loadExample.onclick = () => finishLoading(exampleJS, exampleMap)

const isProbablySourceMap = file => file.name.endsWith('.map') || file.name.endsWith('.json')

const loadFile = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onloadend = () => resolve(reader.result)
    reader.readAsText(file)
  })

const resetLoadingState = () => {
  promptText.style.display = 'block'
  // toolbar.style.display = 'none'
  // statusBar.style.display = 'none'
  canvas.style.display = 'none'
}

const showLoadingError = text => {
  resetLoadingState()
  errorText.style.display = 'block'
  errorText.textContent = text
}

async function finishEmbeddedSourceMap(code, file) {
  let url
  // Check for both "//" and "/*" comments. This is mostly done manually
  // instead of doing it all with a regular expression because Firefox's
  // regular expression engine crashes with an internal error when the
  // match is too big.
  const regex = /\/([*/])[#@] *sourceMappingURL=/g
  let currentMatch = regex.exec(code)
  while (currentMatch !== null) {
    const start = currentMatch.index + currentMatch[0].length
    const n = code.length
    let end = start
    while (end < n && code.charCodeAt(end) > 32) {
      end++
    }
    if (end > start && (currentMatch[1] === '/' || code.slice(end).indexOf('*/') > 0)) {
      url = code.slice(start, end)
      break
    }
    currentMatch = regex.exec(code)
  }

  const showFetchError = (e, match = []) =>
    showLoadingError(`Failed to parse the URL in the "/${match[1]}# sourceMappingURL=" comment: ${e?.message || e}`)

  const fetchUrlMap = url =>
    fetch(new URL(url))
      .then(r => r.text())
      .catch(showFetchError)

  // Check for a non-empty data URL payload
  if (url) {
    const map = await fetchUrlMap(url)
    if (!map) return
    return finishLoading(code, map)
  }

  if (file && isProbablySourceMap(file)) {
    // Allow loading a source map without a generated file because why not
    return finishLoading('', code)
  }

  const c = file?.name?.endsWith('ss') ? '*' : '/'
  // biome-ignore format: hellscape
  return showLoadingError(`Failed to find an embedded "/${c}# sourceMappingURL=" comment in the ${file ? 'imported file' : 'pasted text'}.`)
}

async function startLoading(files) {
  switch (files.length) {
    case 1: {
      const [file0] = files
      const code = await loadFile(file0)
      return finishEmbeddedSourceMap(code, file0)
    }
    case 2: {
      const file0 = files[0]
      const file1 = files[1]
      const pair = []

      if (isProbablySourceMap(file0)) {
        pair[0] = file1
        pair[1] = file0
      }

      // return finishLoading(code, map)
      if (isProbablySourceMap(file1)) {
        pair[0] = file0
        pair[1] = file1
      }

      if (pair.length) {
        const code = await loadFile(pair[0])
        const map = await loadFile(pair[1])
        return finishLoading(code, map)
      }

      return showLoadingError('The source map file must end in either ".map" or ".json" to be detected.')
    }
  }

  return showLoadingError('Please import either 1 or 2 files.')
}

document.body.addEventListener('paste', e => {
  // Don't intercept paste events on input elements
  if (e.target.tagName === 'INPUT') {
    return
  }

  e.preventDefault()
  const code = e.clipboardData.getData('text/plain')
  finishEmbeddedSourceMap(code, null)
})

// Accelerate VLQ decoding with a lookup table
const vlqTable = new Uint8Array(128)
// biome-ignore lint/nursery/noSecrets: hellscape
const vlqChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (let i = 0; i < vlqTable.length; i++) vlqTable[i] = 0xff
for (let i = 0; i < vlqChars.length; i++) vlqTable[vlqChars.charCodeAt(i)] = i

function decodeError(text, i) {
  const error = `Invalid VLQ data at index ${i}: ${text}`
  showLoadingError(`The "mappings" field of the imported source map contains invalid data. ${error}.`)
  throw new Error(error)
}

function decodeVLQ(mappings, i) {
  let shift = 0
  let vlq = 0
  let inner = i
  // Scan over the input
  while (true) {
    // Read a byte
    if (inner >= mappings.length) decodeError('Unexpected early end of mapping data', inner)
    const c = mappings.charCodeAt(inner)
    if ((c & 0x7f) !== c) decodeError(`Invalid mapping character: ${JSON.stringify(String.fromCharCode(c))}`, inner)
    const index = vlqTable[c & 0x7f]
    if (index === 0xff) decodeError(`Invalid mapping character: ${JSON.stringify(String.fromCharCode(c))}`, inner)
    inner++

    // Decode the byte
    vlq |= (index & 31) << shift
    shift += 5

    // Stop if there's no continuation bit
    if ((index & 32) === 0) break
  }

  // Recover the signed value
  return [vlq & 1 ? -(vlq >> 1) : vlq >> 1, inner]
}

function decodeMappings(mappings, sourcesCount, namesCount) {
  const n = mappings.length
  let data = new Int32Array(1024)
  let dataLength = 0
  let generatedLine = 0
  let generatedLineStart = 0
  let generatedColumn = 0
  let originalSource = 0
  let originalLine = 0
  let originalColumn = 0
  let originalName = 0
  let needToSortGeneratedColumns = false
  let i = 0

  while (i < n) {
    let c = mappings.charCodeAt(i)

    // Handle a line break
    if (c === 59 /* ; */) {
      // The generated columns are very rarely out of order. In that case,
      // sort them with insertion since they are very likely almost ordered.
      if (needToSortGeneratedColumns) {
        for (let j = generatedLineStart + 6; j < dataLength; j += 6) {
          const genL = data[j]
          const genC = data[j + 1]
          const origS = data[j + 2]
          const origL = data[j + 3]
          const origC = data[j + 4]
          const origN = data[j + 5]
          let k = j - 6
          for (; k >= generatedLineStart && data[k + 1] > genC; k -= 6) {
            data[k + 6] = data[k]
            data[k + 7] = data[k + 1]
            data[k + 8] = data[k + 2]
            data[k + 9] = data[k + 3]
            data[k + 10] = data[k + 4]
            data[k + 11] = data[k + 5]
          }
          data[k + 6] = genL
          data[k + 7] = genC
          data[k + 8] = origS
          data[k + 9] = origL
          data[k + 10] = origC
          data[k + 11] = origN
        }
      }

      generatedLine++
      generatedColumn = 0
      generatedLineStart = dataLength
      needToSortGeneratedColumns = false
      i++
      continue
    }

    // Ignore stray commas
    if (c === 44 /* , */) {
      i++
      continue
    }

    // Read the generated column
    const [generatedColumnDelta, ii1] = decodeVLQ(mappings, i)
    i = ii1
    if (generatedColumnDelta < 0) needToSortGeneratedColumns = true
    generatedColumn += generatedColumnDelta
    if (generatedColumn < 0) decodeError(`Invalid generated column: ${generatedColumn}`, i)

    // It's valid for a mapping to have 1, 4, or 5 variable-length fields
    let isOriginalSourceMissing = true
    let isOriginalNameMissing = true
    if (i < n) {
      c = mappings.charCodeAt(i)
      if (c === 44 /* , */) {
        i++
      } else if (c !== 59 /* ; */) {
        isOriginalSourceMissing = false

        // Read the original source
        const [originalSourceDelta, ii2] = decodeVLQ(mappings, i)
        i = ii2
        originalSource += originalSourceDelta
        if (originalSource < 0 || originalSource >= sourcesCount)
          decodeError(`Original source index ${originalSource} is invalid (there are ${sourcesCount} sources)`, i)

        // Read the original line
        const [originalLineDelta, ii3] = decodeVLQ(mappings, i)
        i = ii3
        originalLine += originalLineDelta
        if (originalLine < 0) decodeError(`Invalid original line: ${originalLine}`, i)

        // Read the original column
        const [originalColumnDelta, ii4] = decodeVLQ(mappings, i)
        i = ii4
        originalColumn += originalColumnDelta
        if (originalColumn < 0) decodeError(`Invalid original column: ${originalColumn}`, i)

        // Check for the optional name index
        if (i < n) {
          c = mappings.charCodeAt(i)
          if (c === 44 /* , */) {
            i++
          } else if (c !== 59 /* ; */) {
            isOriginalNameMissing = false

            // Read the optional name index
            const [originalNameDelta, ii5] = decodeVLQ(mappings, i)
            i = ii5
            originalName += originalNameDelta
            if (originalName < 0 || originalName >= namesCount)
              decodeError(`Original name index ${originalName} is invalid (there are ${namesCount} names)`, i)

            // Handle the next character
            if (i < n) {
              c = mappings.charCodeAt(i)
              if (c === 44 /* , */) {
                i++
              } else if (c !== 59 /* ; */) {
                decodeError(`Invalid character after mapping: ${JSON.stringify(String.fromCharCode(c))}`, i)
              }

              /* XXX: WHAT IS THIS NIGHTMARE */
            }
          }
        }
      }
    }

    // Append the mapping to the typed array
    if (dataLength + 6 > data.length) {
      const newData = new Int32Array(data.length << 1)
      newData.set(data)
      data = newData
    }
    data[dataLength] = generatedLine
    data[dataLength + 1] = generatedColumn
    if (isOriginalSourceMissing) {
      data[dataLength + 2] = -1
      data[dataLength + 3] = -1
      data[dataLength + 4] = -1
    } else {
      data[dataLength + 2] = originalSource
      data[dataLength + 3] = originalLine
      data[dataLength + 4] = originalColumn
    }
    data[dataLength + 5] = isOriginalNameMissing ? -1 : originalName
    dataLength += 6
  }

  return data.subarray(0, dataLength)
}

function generateInverseMappings(sources, data) {
  let longestDataLength = 0

  // Scatter the mappings to the individual sources
  for (let i = 0, n = data.length; i < n; i += 6) {
    const originalSource = data[i + 2]
    if (originalSource === -1) continue

    const source = sources[originalSource]
    let inverseData = source.data
    let j = source.dataLength

    // Append the mapping to the typed array
    if (j + 6 > inverseData.length) {
      const newLength = inverseData.length << 1
      const newData = new Int32Array(newLength > 1_024 ? newLength : 1_024)
      newData.set(inverseData)
      source.data = inverseData = newData
    }
    inverseData[j] = data[i]
    inverseData[j + 1] = data[i + 1]
    inverseData[j + 2] = originalSource
    inverseData[j + 3] = data[i + 3]
    inverseData[j + 4] = data[i + 4]
    inverseData[j + 5] = data[i + 5]
    j += 6
    source.dataLength = j
    if (j > longestDataLength) longestDataLength = j
  }

  // Sort the mappings for each individual source
  const temp = new Int32Array(longestDataLength)
  for (const source of sources) {
    const data = source.data.subarray(0, source.dataLength)

    // Sort lazily for performance
    let isSorted = false
    Object.defineProperty(source, 'data', {
      get() {
        if (!isSorted) {
          temp.set(data)
          topDownSplitMerge(temp, 0, data.length, data)
          isSorted = true
        }
        return data
      },
    })
  }

  // From: https://en.wikipedia.org/wiki/Merge_sort
  function topDownSplitMerge(B, iBegin, iEnd, A) {
    if (iEnd - iBegin <= 6) return

    // Optimization: Don't do merge sort if it's already sorted
    let isAlreadySorted = true
    for (let i = iBegin + 3, j = i + 6; j < iEnd; i = j, j += 6) {
      // Compare mappings first by original line (index 3) and then by original column (index 4)
      if (A[i] < A[j] || (A[i] === A[j] && A[i + 1] <= A[j + 1])) continue
      isAlreadySorted = false
      break
    }
    if (isAlreadySorted) {
      return
    }

    const iMiddle = ((iEnd / 6 + iBegin / 6) >> 1) * 6
    topDownSplitMerge(A, iBegin, iMiddle, B)
    topDownSplitMerge(A, iMiddle, iEnd, B)
    topDownMerge(B, iBegin, iMiddle, iEnd, A)
  }

  // From: https://en.wikipedia.org/wiki/Merge_sort
  function topDownMerge(A, iBegin, iMiddle, iEnd, B) {
    let i = iBegin
    let j = iMiddle
    for (let k = iBegin; k < iEnd; k += 6) {
      if (
        i < iMiddle &&
        (j >= iEnd ||
          // Compare mappings first by original line (index 3) and then by original column (index 4)
          A[i + 3] < A[j + 3] ||
          (A[i + 3] === A[j + 3] && A[i + 4] <= A[j + 4]))
      ) {
        B[k] = A[i]
        B[k + 1] = A[i + 1]
        B[k + 2] = A[i + 2]
        B[k + 3] = A[i + 3]
        B[k + 4] = A[i + 4]
        B[k + 5] = A[i + 5]
        i += 6
      } else {
        B[k] = A[j]
        B[k + 1] = A[j + 1]
        B[k + 2] = A[j + 2]
        B[k + 3] = A[j + 3]
        B[k + 4] = A[j + 4]
        B[k + 5] = A[j + 5]
        j += 6
      }
    }
  }
}

const validateSourceMapVersion = json => {
  if (json?.version !== 3) {
    showLoadingError(
      `The imported source map is invalid. Expected the "version" field to be 3 but got ${json?.version}.`,
    )
    throw new Error('Invalid source map')
  }
}

const validateSourceMapSources = (map, sectionIndex = null) => {
  if (!Array.isArray(map.sources) || map.sources.some(x => typeof x !== 'string')) {
    const context = sectionIndex !== null ? ` for section ${sectionIndex}` : ''
    showLoadingError(
      `The imported source map is invalid. Expected the "sources" field${context} to be an array of strings.`,
    )
    throw new Error('Invalid source map')
  }
}

const validateSourceMapMappings = (map, sectionIndex = null) => {
  if (typeof map.mappings !== 'string') {
    const context = sectionIndex !== null ? ` for section ${sectionIndex}` : ''
    showLoadingError(`The imported source map is invalid. Expected the "mappings" field${context} to be a string.`)
    throw new Error('Invalid source map')
  }
}

const initializeSourceData = (sources, sourcesContent) => {
  const emptyData = new Int32Array(0)
  return sources.map((x, i) => ({
    name: x,
    content: sourcesContent?.[i] ?? '',
    data: emptyData,
    dataLength: 0,
  }))
}

const parseSourceMap = sourceMapJson => {
  const parsedJson = JSON.parse(sourceMapJson)
  try {
    validateSourceMapVersion(parsedJson)

    if (Array.isArray(parsedJson.sections)) {
      const sections = parsedJson.sections
      const decodedSections = []
      let totalDataLength = 0

      for (let i = 0; i < sections.length; i++) {
        const {
          offset: { line, column },
          map,
        } = sections[i]
        if (typeof line !== 'number' || typeof column !== 'number') {
          showLoadingError(
            `The imported source map is invalid. Expected the "offset" field for section ${i} to have a line and column.`,
          )
          throw new Error('Invalid source map')
        }

        if (!map) {
          showLoadingError(`The imported source map is unsupported. Section ${i} does not contain a "map" field.`)
          throw new Error('Invalid source map')
        }

        validateSourceMapVersion(map, i)
        validateSourceMapSources(map, i)
        validateSourceMapMappings(map, i)

        const { sources, sourcesContent, names, mappings } = map
        initializeSourceData(sources, sourcesContent)

        const data = decodeMappings(mappings, sources.length, names?.length ?? 0)
        decodedSections.push({ offset: { line, column }, sources, names, data })
        totalDataLength += data.length
      }

      decodedSections.sort((a, b) => {
        if (a.offset.line < b.offset.line) return -1
        if (a.offset.line > b.offset.line) return 1
        if (a.offset.column < b.offset.column) return -1
        if (a.offset.column > b.offset.column) return 1
        return 0
      })

      const mergedData = new Int32Array(totalDataLength)
      const mergedSources = []
      const mergedNames = []
      // const dataOffset = 0

      for (const section of decodedSections) {
        const {
          offset: { line, column },
          // sources,
          // names,
          data,
        } = section
        // const sourcesOffset = mergedSources.length
        // const nameOffset = mergedNames.length

        for (let i = 0; i < data.length; i += 6) {
          const isZeroLine = data[i] === 0
          if (isZeroLine) {
            data[i + 1] += column
          }
          data[i] += line
        }
      }

      generateInverseMappings(mergedSources, mergedData)
      return {
        sources: mergedSources,
        names: mergedNames,
        data: mergedData,
      }
    }

    if (!Array.isArray(parsedJson?.sources) || parsedJson?.sources?.some(x => typeof x !== 'string')) {
      showLoadingError('The imported source map is invalid. Expected the "sources" field to be an array of strings.')
      throw new Error('Invalid source map')
    }

    if (typeof parsedJson?.mappings !== 'string') {
      showLoadingError('The imported source map is invalid. Expected the "mappings" field to be a string.')
      throw new Error('Invalid source map')
    }

    const { sources, sourcesContent, names, mappings } = parsedJson
    const emptyData = new Int32Array(0)
    for (let i = 0; i < sources?.length ?? 0; i++) {
      sources[i] = {
        name: sources[i],
        content: sourcesContent?.[i] ?? '',
        data: emptyData,
        dataLength: 0,
      }
    }

    const data = decodeMappings(mappings, sources.length, names ? names.length : 0)
    generateInverseMappings(sources, data)
    return { sources, names, data }
  } catch (e) {
    showLoadingError(`The imported source map contains invalid JSON data: ${e?.message ?? e}`)
    throw e
  }
}

function waitForDOM() {
  return new Promise(r => setTimeout(r, 1))
}

async function finishLoading(code, map) {
  const startTime = Date.now()
  promptText.style.display = 'none'
  // toolbar.style.display = 'flex'
  // statusBar.style.display = 'flex'
  canvas.style.display = 'block'
  // originalStatus.textContent = generatedStatus.textContent = ''
  // fileList.innerHTML = ''
  // const option = document.createElement('option')
  // option.textContent = 'Loading...'
  // fileList.appendChild(option)
  // fileList.disabled = true
  // fileList.selectedIndex = 0
  originalTextArea = generatedTextArea = hover = null
  isInvalid = true

  // Let the browser update before parsing the source map, which may be slow
  await waitForDOM()
  const sm = parseSourceMap(map)

  // Show a progress bar if this is is going to take a while
  let charsSoFar = 0
  let progressCalls = 0
  let isProgressVisible = false
  const progressStart = Date.now()
  const totalChars = code.length + (sm.sources.length > 0 ? sm.sources[0].content.length : 0)
  const progress = chars => {
    charsSoFar += chars
    if (!isProgressVisible && progressCalls++ > 2 && charsSoFar) {
      const estimatedTimeLeftMS = ((Date.now() - progressStart) / charsSoFar) * (totalChars - charsSoFar)
      if (estimatedTimeLeftMS > 250) {
        // progressBarOverlay.style.display = 'block'
        isProgressVisible = true
      }
    }
    if (isProgressVisible) {
      // progressBar.style.transform = `scaleX(${charsSoFar / totalChars})`
      return waitForDOM()
    }
  }
  // progressBar.style.transform = 'scaleX(0)'

  // Update the original text area when the source changes
  const otherSource = index => (index === -1 ? null : sm.sources[index].name)
  const originalName = index => sm.names[index]
  let finalOriginalTextArea = null
  if (sm.sources.length > 0) {
    const updateOriginalSource = (sourceIndex, progress) => {
      const source = sm.sources[sourceIndex]
      return createTextArea({
        sourceIndex,
        text: source.content,
        progress,
        mappings: source.data,
        mappingsOffset: 3,
        otherSource,
        originalName,
        bounds() {
          return {
            x: 0,
            y: 0,
            width: (innerWidth >>> 1) - (splitterWidth >> 1),
            height: innerHeight,
          }
        },
      })
    }
    // fileList.onchange = async () => {
    //   originalTextArea = await updateOriginalSource(fileList.selectedIndex)
    //   isInvalid = true
    // }
    finalOriginalTextArea = await updateOriginalSource(0, progress)
  }

  generatedTextArea = await createTextArea({
    sourceIndex: null,
    text: code,
    progress,
    mappings: sm.data,
    mappingsOffset: 0,
    otherSource,
    originalName,
    bounds() {
      const x = (innerWidth >> 1) + ((splitterWidth + 1) >> 1)
      return {
        x,
        y: 0,
        width: innerWidth - x,
        height: innerHeight,
      }
    },
  })

  // Only render the original text area once the generated text area is ready
  originalTextArea = finalOriginalTextArea
  isInvalid = true

  // Populate the file picker once there will be no more await points
  // fileList.innerHTML = ''
  if (sm.sources.length) {
    for (let sources = sm.sources, i = 0, n = sources.length; i < n; i++) {
      const option = document.createElement('option')
      option.textContent = `${i}: ${sources[i].name}`
      // fileList.appendChild(option)
    }
    // fileList.disabled = false
  } else {
    const option = document.createElement('option')
    option.textContent = '(no original code)'
    // fileList.appendChild(option)
  }
  // fileList.selectedIndex = 0

  const endTime = Date.now()
  console.log(`Finished loading in ${endTime - startTime}ms`)
}

////////////////////////////////////////////////////////////////////////////////
// Drawing

const originalLineColors = [
  'rgba(25, 133, 255, 0.3)', // Blue
  'rgba(174, 97, 174, 0.3)', // Purple
  'rgba(255, 97, 106, 0.3)', // Red
  'rgba(250, 192, 61, 0.3)', // Yellow
  'rgba(115, 192, 88, 0.3)', // Green
]

// Use a striped pattern for bad mappings (good mappings are solid)
const patternContours = [
  [0, 24, 24, 0, 12, 0, 0, 12, 0, 24],
  [0, 28, 28, 0, 40, 0, 0, 40, 0, 28],
  [0, 44, 44, 0, 56, 0, 0, 56, 0, 44],
  [12, 64, 24, 64, 64, 24, 64, 12, 12, 64],
  [0, 60, 0, 64, 8, 64, 64, 8, 64, 0, 60, 0, 0, 60],
  [28, 64, 40, 64, 64, 40, 64, 28, 28, 64],
  [0, 8, 8, 0, 0, 0, 0, 8],
  [44, 64, 56, 64, 64, 56, 64, 44, 44, 64],
  [64, 64, 64, 60, 60, 64, 64, 64],
]
const badMappingPatterns = originalLineColors.map(color => {
  const patternCanvas = document.createElement('canvas')
  const patternContext = patternCanvas.getContext('2d')
  let canvasWidth = 0
  let canvasHeight = 0
  // let ratio
  let scale
  let pattern

  return (dx, dy) => {
    const width = Math.ceil(dx)
    const height = Math.ceil(dy)

    if (canvasWidth < width || canvasHeight < height) {
      canvasWidth = Math.max(canvasWidth, width)
      canvasHeight = Math.max(canvasHeight, height)
      patternCanvas.width = canvasWidth
      patternCanvas.height = canvasHeight
      pattern = null
    }

    if (pattern === null) {
      patternContext.clearRect(0, 0, canvasWidth, canvasHeight)
      patternContext.beginPath()
      for (const contour of patternContours) {
        for (let i = 0; i < contour.length; i += 2) {
          if (i === 0) patternContext.moveTo(contour[i], contour[i + 1])
          else patternContext.lineTo(contour[i], contour[i + 1])
        }
      }
      patternContext.fillStyle = color.replace(' 0.3)', ' 0.2)')
      patternContext.fill()
      pattern = c.createPattern(patternCanvas, 'repeat')
    }
    if (pattern) {
      pattern.setTransform(new DOMMatrix([1 / scale, 0, 0, 1 / scale, dx, dy]))
      return pattern
    }
    return color // Fallback to solid color if pattern creation fails
  }
})

const canvas = document.createElement('canvas')
const c = canvas.getContext('2d')
const monospaceFont = '14px monospace'
const rowHeight = 21
const splitterWidth = 6
const margin = 40
let isInvalid = true
let originalTextArea
let generatedTextArea
let hover = null

// const wrapCheckbox = document.getElementById('wrap')
// const wrap = localStorage.getItem('wrap') !== 'false'
// wrapCheckbox.checked = wrap
// wrapCheckbox.onchange = () => {
//   localStorage.setItem('wrap', wrapCheckbox.checked)
//   if (originalTextArea) originalTextArea.updateAfterWrapChange()
//   if (generatedTextArea) generatedTextArea.updateAfterWrapChange()
//   isInvalid = true
// }

async function splitTextIntoLinesAndRuns(text, progress) {
  c.font = monospaceFont
  const spaceWidth = c.measureText(' ').width
  const spacesPerTab = 2
  const parts = text.split(/(\r\n|\r|\n)/g)
  const unicodeWidthCache = new Map()
  const lines = []
  const progressChunkSize = 1 << 20
  let longestColumnForLine = new Int32Array(1024)
  let runData = new Int32Array(1024)
  let runDataLength = 0
  let prevProgressPoint = 0
  let longestLineInColumns = 0
  let lineStartOffset = 0

  for (let part = 0; part < parts.length; part++) {
    const raw = parts[part]
    if (part & 1) {
      // Accumulate the length of the newline (CRLF uses two code units)
      lineStartOffset += raw.length
      continue
    }

    const runBase = runDataLength
    const n = raw.length + 1 // Add 1 for the extra character at the end
    let nextProgressPoint = progress
      ? prevProgressPoint + progressChunkSize - lineStartOffset
      : Number.POSITIVE_INFINITY
    let i = 0
    let column = 0

    while (i < n) {
      const startIndex = i
      const startColumn = column
      let whitespace = 0
      let isSingleChunk = false

      // Update the progress bar occasionally
      if (i > nextProgressPoint) {
        await progress(lineStartOffset + i - prevProgressPoint)
        prevProgressPoint = lineStartOffset + i
        nextProgressPoint = i + progressChunkSize
      }

      while (i < n) {
        let c1 = raw.charCodeAt(i)
        let c2

        // Draw each tab into its own run
        if (c1 === 0x09 /* tab */) {
          if (i > startIndex) break
          isSingleChunk = true
          column += spacesPerTab
          column -= column % spacesPerTab
          i++
          whitespace = c1
          break
        }

        // Draw each newline into its own run
        if (Number.isNaN(c1)) {
          if (i > startIndex) break
          isSingleChunk = true
          column++
          i++
          whitespace = 0x0a /* newline */
          break
        }

        // Draw each non-ASCII character into its own run (e.g. emoji)
        if (c1 < 0x20 || c1 > 0x7e) {
          if (i > startIndex) break
          isSingleChunk = true
          i++

          // Consume another code unit if this code unit is a high surrogate
          // and the next code point is a low surrogate. This handles code
          // points that span two UTF-16 code units.
          if (i < n && c1 >= 0xd800 && c1 <= 0xdbff) {
            c2 = raw.charCodeAt(i)
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
              i++
            }
          }

          // This contains some logic to handle more complex emoji such as "����♂"
          // which is [U+1F46F, U+200D, U+2642, U+FE0F].
          while (i < n) {
            c1 = raw.charCodeAt(i)

            // Consume another code unit if the next code point is a variation selector
            if ((c1 & ~0xf) === 0xfe00) {
              i++
            }

            // Consume another code unit if the next code point is a skin tone modifier
            else if (c1 === 0xd83c && i + 1 < n) {
              c2 = raw.charCodeAt(i + 1)
              if (c2 >= 0xdffb && c2 <= 0xdfff) {
                i += 2
              }
            }

            // Consume another code unit and stop if the next code point is a zero-width non-joiner
            else if (c1 === 0x200c) {
              i++
              break
            }

            // Consume another code unit if the next code point is a zero-width joiner
            else if (c1 === 0x200d) {
              i++

              // Consume the next code point that is "joined" to this one
              if (i < n) {
                c1 = raw.charCodeAt(i)
                i++
                if (c1 >= 0xd800 && c1 <= 0xdbff && i < n) {
                  c2 = raw.charCodeAt(i)
                  if (c2 >= 0xdc00 && c2 <= 0xdfff) {
                    i++
                  }
                }
              }
            } else {
              /* XXX: STUCK IN PURGATORY */
              break
            }
          }

          const key = raw.slice(startIndex, i)
          const charw = unicodeWidthCache.get(key)
          const width = charw === 0 ? Math.round(c.measureText(key).width / spaceWidth) : (charw ?? 1)
          unicodeWidthCache.set(key, width)
          column += width
          break
        }

        // Draw runs of spaces in their own run
        if (c1 === 0x20 /* space */) {
          if (i === startIndex) whitespace = c1
          else if (!whitespace) break
        } else {
          if (whitespace) break
        }

        column++
        i++
      }

      // Append the run to the typed array
      if (runDataLength + 5 > runData.length) {
        const newData = new Int32Array(runData.length << 1)
        newData.set(runData)
        runData = newData
      }
      runData[runDataLength] = whitespace | (isSingleChunk ? 0x100 /* isSingleChunk */ : 0)
      runData[runDataLength + 1] = startIndex
      runData[runDataLength + 2] = i
      runData[runDataLength + 3] = startColumn
      runData[runDataLength + 4] = column
      runDataLength += 5
    }

    const lineIndex = lines.length
    if (lineIndex >= longestColumnForLine.length) {
      const newData = new Int32Array(longestColumnForLine.length << 1)
      newData.set(longestColumnForLine)
      longestColumnForLine = newData
    }
    longestColumnForLine[lineIndex] = column

    const runCount = (runDataLength - runBase) / 5
    lines.push({ raw, runBase, runCount, runText: {}, endIndex: i, endColumn: column })
    longestLineInColumns = Math.max(longestLineInColumns, column)
    lineStartOffset += raw.length
  }

  if (prevProgressPoint < text.length && progress) {
    await progress(text.length - prevProgressPoint)
  }

  return {
    lines,
    longestColumnForLine,
    longestLineInColumns,
    runData: runData.subarray(0, runDataLength),
  }
}

async function createTextArea({
  sourceIndex,
  text,
  progress,
  mappings,
  mappingsOffset,
  otherSource,
  originalName,
  bounds,
}) {
  const shadowWidth = 16
  const textPaddingX = 5
  const textPaddingY = 1
  const scrollbarThickness = 16
  const hoverBoxLineThickness = 4

  // Runs are stored in a flat typed array to improve loading time
  const runWhitespace = index => runData[index] & 0xff
  const runIsSingleChunk = index => runData[index] & 0x100
  const runStartIndex = index => runData[index + 1]
  const runEndIndex = index => runData[index + 2]
  const runStartColumn = index => runData[index + 3]
  const runEndColumn = index => runData[index + 4]

  let { lines, longestColumnForLine, longestLineInColumns, runData } = await splitTextIntoLinesAndRuns(text, progress)
  let animate = null
  let lastLineIndex = lines.length - 1
  let scrollX = 0
  let scrollY = 0

  // Source mappings may lie outside of the source code. This happens both
  // when the source code is missing or when the source mappings are buggy.
  // In these cases, we should extend the scroll area to allow the user to
  // view these out-of-bounds source mappings.
  for (let i = 0, n = mappings.length; i < n; i += 6) {
    const line = mappings[i + mappingsOffset]
    let column = mappings[i + mappingsOffset + 1]
    if (line < lines.length) {
      const { endIndex, endColumn } = lines[line]

      // Take into account tabs tops and surrogate pairs
      if (endColumn > column) {
        column = endColumn
      } else if (column > endColumn) {
        column = column - endIndex + endColumn
      }
    } else if (line > lastLineIndex) {
      lastLineIndex = line
    }
    if (column > longestLineInColumns) {
      longestLineInColumns = column
    }
    if (line >= longestColumnForLine.length) {
      const newData = new Int32Array(longestColumnForLine.length << 1)
      newData.set(longestColumnForLine)
      longestColumnForLine = newData
    }
    longestColumnForLine[line] = column
  }

  const wrappedRowsCache = new Map()

  const computeColumnsAcross = (width, columnWidth) =>
    Math.max(1, Math.floor((width - margin - textPaddingX - scrollbarThickness) / columnWidth))
  // : Number.POSITIVE_INFINITY

  function wrappedRowsForColumns(columnsAcross) {
    let result = wrappedRowsCache.get(columnsAcross)
    if (!result) {
      result = new Int32Array(lastLineIndex + 2)
      let rows = 0
      const n = lastLineIndex + 1
      if (columnsAcross === Number.POSITIVE_INFINITY) {
        for (let i = 0; i <= n; i++) {
          result[i] = i
        }
      } else {
        for (let i = 0; i < n; i++) {
          result[i] = rows
          rows += Math.ceil(longestColumnForLine[i] / columnsAcross) || 1
        }
        result[n] = rows
      }
      wrappedRowsCache.set(columnsAcross, result)
    }
    return result
  }

  function computeScrollbarsAndClampScroll() {
    const { width, height } = bounds()
    c.font = '14px monospace'
    const columnWidth = c.measureText(' '.repeat(64)).width / 64
    const columnsAcross = computeColumnsAcross(width, columnWidth)
    const wrappedRows = wrappedRowsForColumns(columnsAcross)

    let scrollbarX = null
    let scrollbarY = null
    let maxScrollX
    let maxScrollY

    maxScrollX = 0
    maxScrollY = (wrappedRowsForColumns(computeColumnsAcross(width, columnWidth))[lastLineIndex + 1] - 1) * rowHeight

    scrollX = Math.max(0, Math.min(scrollX, maxScrollX))
    scrollY = Math.max(0, Math.min(scrollY, maxScrollY))

    if (maxScrollX > 0) {
      const trackLength = width - margin - scrollbarThickness / 2
      scrollbarX = {
        trackLength,
        thumbLength: Math.max(scrollbarThickness * 2, trackLength / (1 + maxScrollX / trackLength)),
      }
    }

    if (maxScrollY > 0) {
      const trackLength = height - scrollbarThickness / 2
      scrollbarY = {
        trackLength,
        thumbLength: Math.max(scrollbarThickness * 2, trackLength / (1 + maxScrollY / trackLength)),
      }
    }

    return {
      columnWidth,
      columnsAcross,
      wrappedRows,
      maxScrollX,
      maxScrollY,
      scrollbarX,
      scrollbarY,
    }
  }

  const emptyLine = { raw: '', runCount: 0 }

  function analyzeLine(line, column, fractionalColumn, tabStopBehavior) {
    let index = column
    let firstRun = 0
    let nearbyRun = 0
    let firstMapping = 0
    const { raw, runBase, runCount, runText } = line < lines.length ? lines[line] : emptyLine
    let runLimit = runCount
    let endOfLineIndex = 0
    let endOfLineColumn = 0
    let beforeNewlineIndex = 0
    let hasTrailingNewline = false

    if (runLimit > 0) {
      const lastRun = runBase + 5 * (runLimit - 1)
      endOfLineIndex = runEndIndex(lastRun)
      endOfLineColumn = runEndColumn(lastRun)
      beforeNewlineIndex = runStartIndex(lastRun)
      hasTrailingNewline = runWhitespace(lastRun) === 0x0a /* newline */

      // Binary search to find the first run
      firstRun = 0
      while (runLimit > 0) {
        const step = runLimit >> 1
        const it = firstRun + step
        if (runEndColumn(runBase + 5 * it) < column) {
          firstRun = it + 1
          runLimit -= step + 1
        } else {
          runLimit = step
        }
      }

      // Use the last run if we're past the end of the line
      if (firstRun >= runCount) firstRun--

      // Convert column to index
      nearbyRun = firstRun
      while (runStartColumn(runBase + 5 * nearbyRun) > column && nearbyRun > 0) nearbyRun--
      while (runEndColumn(runBase + 5 * nearbyRun) < column && nearbyRun + 1 < runCount) nearbyRun++
      const run = runBase + 5 * nearbyRun
      if (runIsSingleChunk(run) && column <= runEndColumn(run)) {
        // A special case for single-character blocks such as tabs and emoji
        if (
          (tabStopBehavior === 'round' && fractionalColumn >= (runStartColumn(run) + runEndColumn(run)) / 2) ||
          (tabStopBehavior === 'floor' && fractionalColumn >= runEndColumn(run))
        ) {
          const newIndex = runEndIndex(run)
          const newColumn = runEndColumn(run)
          return {
            raw,
            index: newIndex,
            column: newColumn,
            firstRun,
            runBase,
            runCount,
            runText,
            firstMapping,
            endOfLineIndex,
            endOfLineColumn,
            columnToIndex,
            indexToColumn,
            rangeOfMapping,
          }
        }
        const newIndex = runStartIndex(run)
        const newColumn = runStartColumn(run)
        return {
          raw,
          index: newIndex,
          column: newColumn,
          firstRun,
          runBase,
          runCount,
          runText,
          firstMapping,
          endOfLineIndex,
          endOfLineColumn,
          columnToIndex,
          indexToColumn,
          rangeOfMapping,
        }
      }
      index = runStartIndex(run) + column - runStartColumn(run)
    }

    // Binary search to find the first mapping that is >= index
    let mappingCount = mappings.length
    while (mappingCount > 0) {
      const step = ((mappingCount / 6) >> 1) * 6
      const it = firstMapping + step
      const mappingLine = mappings[it + mappingsOffset]
      if (mappingLine < line || (mappingLine === line && mappings[it + mappingsOffset + 1] < index)) {
        firstMapping = it + 6
        mappingCount -= step + 6
      } else {
        mappingCount = step
      }
    }

    // Back up to the previous mapping if we're at the end of the line or the mapping we found is after us
    if (
      firstMapping > 0 &&
      mappings[firstMapping - 6 + mappingsOffset] === line &&
      (firstMapping >= mappings.length ||
        mappings[firstMapping + mappingsOffset] > line ||
        mappings[firstMapping + mappingsOffset + 1] > index)
    ) {
      firstMapping -= 6
    }

    // Seek to the first of any duplicate mappings
    const current = mappings[firstMapping + mappingsOffset + 1]
    while (
      firstMapping > 0 &&
      mappings[firstMapping - 6 + mappingsOffset] === line &&
      mappings[firstMapping - 6 + mappingsOffset + 1] === current
    ) {
      firstMapping -= 6
    }

    function columnToIndex(column) {
      // If there is no underlying line, just use one index per column
      let index = column
      if (runCount > 0) {
        while (runStartColumn(runBase + 5 * nearbyRun) > column && nearbyRun > 0) nearbyRun--
        while (runEndColumn(runBase + 5 * nearbyRun) < column && nearbyRun + 1 < runCount) nearbyRun++
        const run = runBase + 5 * nearbyRun
        index = column === runEndColumn(run) ? runEndIndex(run) : runStartIndex(run) + column - runStartColumn(run)
      }
      return index
    }

    function indexToColumn(index) {
      // If there is no underlying line, just use one column per index
      let column = index
      if (runCount > 0) {
        while (runStartIndex(runBase + 5 * nearbyRun) > index && nearbyRun > 0) nearbyRun--
        while (runEndIndex(runBase + 5 * nearbyRun) < index && nearbyRun + 1 < runCount) nearbyRun++
        const run = runBase + 5 * nearbyRun
        column = index === runEndIndex(run) ? runEndColumn(run) : runStartColumn(run) + index - runStartIndex(run)
      }
      return column
    }

    function rangeOfMapping(initialMap) {
      if (mappings[initialMap + mappingsOffset] !== line) return null
      const startIndex = mappings[initialMap + mappingsOffset + 1]
      let endIndex =
        startIndex > endOfLineIndex
          ? startIndex
          : // biome-ignore lint/nursery/noNestedTernary: hellscape
            hasTrailingNewline && startIndex < beforeNewlineIndex
            ? beforeNewlineIndex
            : endOfLineIndex
      let isLastMappingInLine = false

      // Ignore subsequent duplicate mappings
      if (
        initialMap > 0 &&
        mappings[initialMap - 6 + mappingsOffset] === line &&
        mappings[initialMap - 6 + mappingsOffset + 1] === startIndex
      ) {
        return null
      }

      // Find the last duplicate mapping
      let currentMap = initialMap
      while (
        currentMap + 6 < mappings.length &&
        mappings[currentMap + 6 + mappingsOffset] === line &&
        mappings[currentMap + 6 + mappingsOffset + 1] === startIndex
      ) {
        currentMap += 6
      }

      // Extend this mapping up to the next mapping if it's on the same line
      if (currentMap + 6 < mappings.length && mappings[currentMap + 6 + mappingsOffset] === line) {
        endIndex = mappings[currentMap + 6 + mappingsOffset + 1]
      } else if (endIndex === startIndex) {
        isLastMappingInLine = true
      }

      return {
        startIndex,
        startColumn: indexToColumn(startIndex),
        endIndex,
        endColumn: indexToColumn(endIndex),
        isLastMappingInLine,
      }
    }

    return {
      raw,
      index,
      column,
      firstRun,
      runBase,
      runCount,
      runText,
      firstMapping,
      endOfLineIndex,
      endOfLineColumn,
      columnToIndex,
      indexToColumn,
      rangeOfMapping,
    }
  }

  // This returns the index of the line containing the provided row. This is
  // not a 1:1 mapping when line wrapping is enabled. The residual row count
  // (i.e. how many rows are there from the start of the line) can be found
  // with "row - wrappedRows[lineIndex]".
  function lineIndexForRow(wrappedRows, row) {
    let n = lastLineIndex + 1
    if (row > wrappedRows[n]) {
      return n + row - wrappedRows[n]
    }
    let lineIndex = 0
    while (n > 0) {
      const step = n >> 1
      const it = lineIndex + step
      if (wrappedRows[it + 1] <= row) {
        lineIndex = it + 1
        n -= step + 1
      } else {
        n = step
      }
    }
    return lineIndex
  }

  function boxForRange(dx, dy, columnWidth, { startColumn, endColumn }) {
    const x1 = Math.round(dx + startColumn * columnWidth + 1)
    const x2 = Math.round(
      dx + (startColumn === endColumn ? startColumn * columnWidth + 4 : endColumn * columnWidth) - 1,
    )
    const y1 = Math.round(dy + 2)
    const y2 = Math.round(dy + +rowHeight - 2)
    return [x1, y1, x2, y2]
  }

  return {
    sourceIndex,
    bounds,

    updateAfterWrapChange() {
      scrollX = 0
      computeScrollbarsAndClampScroll()
    },

    getHoverRect() {
      const lineIndex = sourceIndex === null ? hover.mapping.generatedLine : hover.mapping.originalLine
      const index = sourceIndex === null ? hover.mapping.generatedColumn : hover.mapping.originalColumn
      const column = analyzeLine(lineIndex, index, index, 'floor').indexToColumn(index)
      const { firstMapping, rangeOfMapping } = analyzeLine(lineIndex, column, column, 'floor')
      const range = rangeOfMapping(firstMapping)
      if (!range) return null
      const { startColumn: rangeStartColumn, endColumn: rangeEndColumn } = range
      const { x } = bounds()
      const { y } = bounds()
      // XXX: JUST HOW MUCH OF IT IS FAKE
      // const { width } = bounds()
      // const { height } = bounds()
      const { columnWidth, columnsAcross, wrappedRows } = computeScrollbarsAndClampScroll()

      // Compute the mouse row accounting for line wrapping
      const rowDelta = Math.floor(column / columnsAcross)
      const row = wrappedRows[lineIndex] + rowDelta
      const dx = x - scrollX + margin + textPaddingX
      const dy = y - scrollY + textPaddingY + row * rowHeight

      // Adjust the mouse column due to line wrapping
      let adjustedStartColumn = rangeStartColumn
      let adjustedEndColumn = rangeEndColumn
      const columnAdjustment = rowDelta * columnsAcross
      adjustedStartColumn -= columnAdjustment
      adjustedEndColumn -= columnAdjustment

      const [x1, y1, x2, y2] = boxForRange(dx, dy, columnWidth, {
        startColumn: adjustedStartColumn,
        endColumn: adjustedEndColumn,
      })
      return [x1, y1, x2 - x1, y2 - y1]
    },

    onwheel(e) {
      const { x, y, width, height } = bounds()
      if (e.pageX >= x && e.pageX < x + width && e.pageY >= y && e.pageY < y + height) {
        scrollX = Math.round(scrollX + e.deltaX)
        scrollY = Math.round(scrollY + e.deltaY)
        computeScrollbarsAndClampScroll()
        isInvalid = true
      }
    },

    onmousemove(e) {
      const { x, y, width, height } = bounds()

      if (e.pageX >= x + margin && e.pageX < x + width - scrollbarThickness && e.pageY >= y && e.pageY < y + height) {
        const { columnWidth, columnsAcross, wrappedRows } = computeScrollbarsAndClampScroll()
        let fractionalColumn = (e.pageX - x - margin - textPaddingX + scrollX) / columnWidth
        let roundedColumn = Math.round(fractionalColumn)

        if (roundedColumn >= 0) {
          const row = Math.floor((e.pageY - y - textPaddingY + scrollY) / rowHeight)

          if (row >= 0) {
            // Adjust the mouse column due to line wrapping
            const lineIndex = lineIndexForRow(wrappedRows, row)
            const firstColumn = lineIndex < wrappedRows.length ? (row - wrappedRows[lineIndex]) * columnsAcross : 0
            const lastColumn = firstColumn + columnsAcross
            fractionalColumn += firstColumn
            roundedColumn += firstColumn

            const flooredColumn = Math.floor(fractionalColumn)
            const { index: snappedRoundedIndex, column: snappedRoundedColumn } = analyzeLine(
              lineIndex,
              roundedColumn,
              fractionalColumn,
              'round',
            )
            const {
              index: snappedFlooredIndex,
              firstMapping,
              rangeOfMapping,
            } = analyzeLine(lineIndex, flooredColumn, fractionalColumn, 'floor')

            // Check to see if this nearest mapping is being hovered
            let mapping = null
            const range = rangeOfMapping(firstMapping)
            if (
              range !== null &&
              // If this is a zero-width mapping, hit-test with the caret
              ((range.isLastMappingInLine && range.startIndex === snappedRoundedIndex) ||
                // Otherwise, determine the bounding-box and hit-test against that
                (snappedFlooredIndex >= range.startIndex &&
                  snappedFlooredIndex < range.endIndex &&
                  range.startColumn < lastColumn &&
                  range.endColumn > firstColumn))
            ) {
              mapping = {
                generatedLine: mappings[firstMapping],
                generatedColumn: mappings[firstMapping + 1],
                originalSource: mappings[firstMapping + 2],
                originalLine: mappings[firstMapping + 3],
                originalColumn: mappings[firstMapping + 4],
                originalName: mappings[firstMapping + 5],
              }
            }

            hover = {
              sourceIndex,
              lineIndex,
              row,
              column: snappedRoundedColumn,
              index: snappedRoundedIndex,
              mapping,
            }
          }
        }
      }
    },

    onmousedown(e) {
      const { x, y, width, height } = bounds()
      const px = e.pageX - x
      const py = e.pageY - y
      if (px < 0 || py < 0 || px >= width || py >= height) return
      const { maxScrollX, maxScrollY, scrollbarX, scrollbarY } = computeScrollbarsAndClampScroll()

      // Handle scrollbar dragging
      let mousemove
      if (scrollbarX && py > height - scrollbarThickness) {
        const originalScrollX = scrollX
        mousemove = e => {
          scrollX = Math.round(
            originalScrollX + ((e.pageX - x - px) * maxScrollX) / (scrollbarX.trackLength - scrollbarX.thumbLength),
          )
          computeScrollbarsAndClampScroll()
          isInvalid = true
        }
      } else if (scrollbarY && px > width - scrollbarThickness) {
        const originalScrollY = scrollY
        mousemove = e => {
          scrollY = Math.round(
            originalScrollY + ((e.pageY - y - py) * maxScrollY) / (scrollbarY.trackLength - scrollbarY.thumbLength),
          )
          computeScrollbarsAndClampScroll()
          isInvalid = true
        }
      } else {
        // Scroll to the hover target on click
        if (hover?.mapping) {
          if (sourceIndex !== null) {
            generatedTextArea.scrollTo(hover.mapping.generatedColumn, hover.mapping.generatedLine)
          } else {
            // if (originalTextArea.sourceIndex !== hover.mapping.originalSource) {
            // fileList.selectedIndex = hover.mapping.originalSource
            // fileList.onchange().then(() => {
            //   originalTextArea.scrollTo(hover.mapping.originalColumn, hover.mapping.originalLine)
            // })
            // } else {
            originalTextArea.scrollTo(hover.mapping.originalColumn, hover.mapping.originalLine)
            // }
          }
        }
        return
      }

      const mouseup = () => {
        document.removeEventListener('mousemove', mousemove)
        document.removeEventListener('mouseup', mouseup)
      }
      document.addEventListener('mousemove', mousemove)
      document.addEventListener('mouseup', mouseup)
      e.preventDefault()
    },

    scrollTo(index, line) {
      const start = Date.now()
      const startX = scrollX
      const startY = scrollY
      const { width, height } = bounds()
      const { columnWidth, columnsAcross, wrappedRows } = computeScrollbarsAndClampScroll()
      const { indexToColumn } = analyzeLine(line, index, index, 'floor')
      const column = indexToColumn(index)
      const { firstMapping, rangeOfMapping } = analyzeLine(line, column, column, 'floor')
      const range = rangeOfMapping(firstMapping)
      const targetColumn = range
        ? range.startColumn + Math.min((range.endColumn - range.startColumn) / 2, (width - margin) / 4 / columnWidth)
        : column
      const endX = Math.max(0, Math.round(targetColumn * columnWidth - (width - margin) / 2))
      const row = wrappedRows[line] + Math.floor(column / columnsAcross)
      const endY = Math.max(0, Math.round((row + 0.5) * rowHeight - height / 2))
      if (startX === endX && startY === endY) return
      const duration = 250
      animate = () => {
        isInvalid = true
        const current = Date.now()
        const t = (current - start) / duration
        if (t >= 1) {
          scrollX = endX
          scrollY = endY
          animate = null
        } else {
          const easeInOutT = t * (3 - 2 * t)
          scrollX = startX + (endX - startX) * easeInOutT
          scrollY = startY + (endY - startY) * easeInOutT
        }
      }
      animate()
    },

    draw(bodyStyle) {
      if (animate) animate()

      const drawRow = (dx, dy, lineIndex, firstColumn, lastColumn) => {
        const {
          raw,
          firstRun,
          runBase,
          runCount,
          runText,
          firstMapping,
          endOfLineColumn,
          rangeOfMapping,
          columnToIndex,
        } = analyzeLine(lineIndex, firstColumn, firstColumn, 'floor')
        const lastIndex = columnToIndex(lastColumn)

        // Don't draw any text if the whole line is offscreen
        if (firstRun < runCount) {
          // Scan to find the last run
          let lastRun = firstRun
          while (lastRun + 1 < runCount && runStartColumn(runBase + 5 * (lastRun + 1)) < lastColumn) {
            lastRun++
          }

          // Draw the runs
          const dyForText = dy + 0.7 * rowHeight
          let currentColumn = firstColumn
          for (let i = firstRun; i <= lastRun; i++) {
            const run = runBase + 5 * i
            let startColumn = runStartColumn(run)
            let endColumn = runEndColumn(run)
            const whitespace = runWhitespace(run)
            let text = runText[i]

            // Lazily-generate text for runs to improve performance. When
            // this happens, the run text is the code unit offset of the
            // start of the line containing this run.
            if (text !== 0) {
              text = runText[i] = !whitespace
                ? raw.slice(runStartIndex(run), runEndIndex(run))
                : // biome-ignore lint/nursery/noNestedTernary: hellscape
                  whitespace === 0x20 /* space */
                  ? '·'.repeat(runEndIndex(run) - runStartIndex(run))
                  : // biome-ignore lint/nursery/noNestedTernary: hellscape
                    whitespace === 0x0a /* newline */
                    ? // biome-ignore lint/nursery/noNestedTernary: hellscape
                      lineIndex === lines.length - 1
                      ? '∅'
                      : '↵'
                    : '→' /* tab */
            }

            // Limit the run to the visible columns (but only for ASCII runs)
            if (!runIsSingleChunk(run)) {
              if (startColumn < currentColumn) {
                text = text.slice(currentColumn - startColumn)
                startColumn = currentColumn
              }
              if (endColumn > lastColumn) {
                text = text.slice(0, lastColumn - startColumn)
                endColumn = lastColumn
              }
            }
            // Draw whitespace in a separate batch
            ;(whitespace ? whitespaceBatch : textBatch).push(text, dx + startColumn * columnWidth, dyForText)
            currentColumn = endColumn
          }
        }

        // Draw the mappings
        for (let map = firstMapping; map < mappings.length; map += 6) {
          if (mappings[map + mappingsOffset] !== lineIndex || mappings[map + mappingsOffset + 1] >= lastIndex) break
          if (mappings[map + 2] === -1) continue

          // Get the bounds of this mapping, which may be empty if it's ignored
          const range = rangeOfMapping(map)
          if (range === null) continue
          const { startColumn, endColumn } = range
          const color = mappings[map + 3] % originalLineColors.length
          const [x1, y1, x2, y2] = boxForRange(dx, dy, columnWidth, range)

          // Check if this mapping is hovered
          let isHovered = false
          if (hoveredMapping) {
            const isGenerated = sourceIndex === null
            const hoverIsGenerated = hover.sourceIndex === null
            const matchesGenerated =
              mappings[map] === hoveredMapping.generatedLine && mappings[map + 1] === hoveredMapping.generatedColumn
            const matchesOriginal =
              mappings[map + 2] === hoveredMapping.originalSource &&
              mappings[map + 3] === hoveredMapping.originalLine &&
              mappings[map + 4] === hoveredMapping.originalColumn
            isHovered =
              hoveredMapping &&
              (isGenerated !== hoverIsGenerated
                ? // If this is on the opposite pane from the mouse, show all
                  // mappings that match the hovered mapping instead of showing
                  // an exact match.
                  matchesGenerated || matchesOriginal
                : // If this is on the same pane as the mouse, only show the exact
                  // mapping instead of showing everything that matches the target
                  // so hovering isn't confusing.
                  // biome-ignore lint/nursery/noNestedTernary: hellscape
                  isGenerated
                  ? matchesGenerated
                  : matchesOriginal)
            if (isGenerated && matchesGenerated && hoveredMapping.originalName !== -1 && !hoveredName) {
              hoveredName = {
                text: originalName(hoveredMapping.originalName),
                x: Math.round(dx + range.startColumn * columnWidth - hoverBoxLineThickness),
                y: Math.round(dy + 1.2 * rowHeight),
              }
            }
          }

          // Add a rectangle to that color's batch
          if (isHovered) {
            hoverBoxes.push({ color, rect: [x1 - 2, y1 - 2, x2 - x1 + 4, y2 - y1 + 4] })
          } else if (lineIndex >= lines.length || startColumn > endOfLineColumn) {
            badMappingBatches[color].push(x1, y1, x2 - x1, y2 - y1)
          } else if (endColumn > endOfLineColumn) {
            const x12 = Math.round(x1 + (endOfLineColumn - startColumn) * columnWidth)
            mappingBatches[color].push(x1, y1, x12 - x1, y2 - y1)
            badMappingBatches[color].push(x12, y1, x2 - x12, y2 - y1)
          } else {
            mappingBatches[color].push(x1, y1, x2 - x1, y2 - y1)
          }
        }
      }

      const { x, y, width, height } = bounds()
      const textColor = bodyStyle.color
      const backgroundColor = bodyStyle.backgroundColor
      const { columnWidth, columnsAcross, wrappedRows, maxScrollX, maxScrollY, scrollbarX, scrollbarY } =
        computeScrollbarsAndClampScroll()

      // Compute the visible column/row rectangle
      const firstColumn = Math.max(0, Math.floor((scrollX - textPaddingX) / columnWidth))
      const lastColumn = Math.max(
        0,
        Math.ceil((scrollX - textPaddingX + width - margin - scrollbarThickness) / columnWidth),
      )
      const firstRow = Math.max(0, Math.floor((scrollY - textPaddingY) / rowHeight))
      const lastRow = Math.max(0, Math.ceil((scrollY - textPaddingY + height) / rowHeight))
      const firstLineIndex = lineIndexForRow(wrappedRows, firstRow)

      // Populate batches for the text
      const hoverBoxes = []
      const hoveredMapping = hover?.mapping
      const mappingBatches = []
      const badMappingBatches = []
      const whitespaceBatch = []
      const textBatch = []
      let hoveredName = null
      let lineIndex = firstLineIndex
      let lineRow = wrappedRows[lineIndex]
      for (let i = 0; i < originalLineColors.length; i++) {
        mappingBatches.push([])
        badMappingBatches.push([])
      }
      for (let row = firstRow; row <= lastRow; row++) {
        const dx = x - scrollX + margin + textPaddingX
        const dy = y - scrollY + textPaddingY + row * rowHeight
        const columnAdjustment = (row - lineRow) * columnsAcross
        drawRow(
          dx - columnAdjustment * columnWidth,
          dy,
          lineIndex,
          columnAdjustment + firstColumn,
          columnAdjustment + Math.max(firstColumn + 1, lastColumn - 1),
        )
        if (lineIndex + 1 >= wrappedRows.length) {
          lineIndex++
          lineRow++
        } else if (row + 1 >= wrappedRows[lineIndex + 1]) {
          lineIndex++
          lineRow = wrappedRows[lineIndex]
        }
      }

      c.save()
      c.beginPath()
      c.rect(x, y, width, height)
      // c.roundRect(x, y, width, height, 90)
      // c.stroke()
      c.clip()

      // Flush batches for mappings
      for (let i = 0; i < mappingBatches.length; i++) {
        let batch = mappingBatches[i]
        if (batch.length > 0) {
          c.fillStyle = originalLineColors[i]
          for (let j = 0; j < batch.length; j += 4) {
            c.fillRect(batch[j], batch[j + 1], batch[j + 2], batch[j + 3])
          }
        }
        batch = badMappingBatches[i]
        if (batch.length > 0) {
          c.fillStyle = badMappingPatterns[i](-scrollX, -scrollY)
          for (let j = 0; j < batch.length; j += 4) {
            c.fillRect(batch[j], batch[j + 1], batch[j + 2], batch[j + 3])
          }
        }
      }

      let status = ''

      // Draw the hover box for all text areas
      if (hoverBoxes.length > 0) {
        // Draw the glows
        c.shadowBlur = 20
        c.fillStyle = 'black'
        for (const {
          rect: [rx, ry, rw, rh],
          color,
        } of hoverBoxes) {
          c.shadowColor = originalLineColors[color].replace(' 0.3)', ' 1)')
          c.fillRect(rx - 1, ry - 1, rw + 2, rh + 2)
        }
        c.shadowColor = 'transparent'

        // Hollow out the boxes and draw a border around each one
        for (const {
          rect: [rx, ry, rw, rh],
        } of hoverBoxes) {
          c.clearRect(rx, ry, rw, rh)
        }
        c.strokeStyle = textColor
        c.lineWidth = hoverBoxLineThickness
        c.shadowBlur = 20
        c.lineJoin = 'round'
        c.lineCap = 'round'
        for (const {
          rect: [rx, ry, rw, rh],
        } of hoverBoxes) {
          c.strokeRect(rx, ry, rw, rh)
        }

        // Hollow out the boxes again. This is necessary to remove overlapping
        // borders from adjacent boxes due to duplicate mappings.
        for (const {
          rect: [rx, ry, rw, rh],
        } of hoverBoxes) {
          c.clearRect(rx + 2, ry + 1, rw - 4, rh - 2)
        }
      }

      // Draw the hover caret, but only for this text area
      else if (hover && hover.sourceIndex === sourceIndex) {
        const column =
          hover.column -
          (hover.lineIndex < wrappedRows.length ? columnsAcross * (hover.row - wrappedRows[hover.lineIndex]) : 0)
        const caretX = Math.round(x - scrollX + margin + textPaddingX + column * columnWidth)
        const caretY = Math.round(y - scrollY + textPaddingY + hover.row * rowHeight)
        c.fillStyle = textColor
        c.globalAlpha = 0.5
        c.fillRect(caretX, caretY, 1, rowHeight)
        c.globalAlpha = 1
        status = `Line ${hover.lineIndex + 1}, Offset ${hover.index}`
      }

      // Update the status bar
      if (hoveredMapping && hoveredMapping.originalColumn !== -1) {
        if (sourceIndex === null) {
          status = `Line ${hoveredMapping.generatedLine + 1}, Offset ${hoveredMapping.generatedColumn}`
        } else {
          status = `Line ${hoveredMapping.originalLine + 1}, Offset ${hoveredMapping.originalColumn}`
          if (hoveredMapping.originalSource !== sourceIndex) {
            status += ` in ${otherSource(hoveredMapping.originalSource)}`
          }
        }
      }
      // ;(sourceIndex === null ? generatedStatus : originalStatus).textContent = status
      const tmpstatus = (sourceIndex === null ? generatedStatus : originalStatus)
      if (tmpstatus) tmpstatus.textContent = status


      // Fade out wrapped mappings and hover boxes
      const wrapLeft = x + margin + textPaddingX
      const wrapRight = wrapLeft + columnsAcross * columnWidth
      // const transparentBackground = backgroundColor.replace(/^rgb\((\d+), (\d+), (\d+)\)$/, 'rgba($1, $2, $3, 0)')
      // const leftFill = c.createLinearGradient(wrapLeft - textPaddingX, 0, wrapLeft, 0)
      // const rightFill = c.createLinearGradient(wrapRight + textPaddingX, 0, wrapRight, 0)

      // leftFill.addColorStop(0, backgroundColor)
      // leftFill.addColorStop(1, transparentBackground)
      // c.fillStyle = leftFill
      // c.fillStyle = 'red'
      // c.fillRect(wrapLeft - textPaddingX, y, textPaddingX, height)

      // rightFill.addColorStop(0, backgroundColor)
      // rightFill.addColorStop(1, transparentBackground)
      // c.fillStyle = rightFill
      // c.fillStyle = 'green'
      // c.fillRect(wrapRight, y, x + width - wrapRight, height)

      // Flush batches for the text, clipped to the wrap area (will cut emojis in half)
      c.textBaseline = 'alphabetic'
      c.textAlign = 'left'
      c.save()
      c.beginPath()
      c.rect(wrapLeft, y, wrapRight - wrapLeft, height)
      c.clip()
      if (whitespaceBatch.length > 0) {
        c.fillStyle = 'rgba(150, 150, 150, 0.4)'
        for (let j = 0; j < whitespaceBatch.length; j += 3) {
          c.fillText(whitespaceBatch[j], whitespaceBatch[j + 1], whitespaceBatch[j + 2])
        }
      }
      if (textBatch.length > 0) {
        c.fillStyle = textColor
        for (let j = 0; j < textBatch.length; j += 3) {
          c.fillText(textBatch[j], textBatch[j + 1], textBatch[j + 2])
        }
      }
      c.restore()

      // Draw the original name tooltip
      if (hoveredName) {
        let { text, x: nameX, y: nameY } = hoveredName
        const w = 2 * textPaddingX + c.measureText(text).width
        const h = rowHeight
        const r = 4
        // Clamp the tooltip in the viewport when wrapping is enabled
        nameX = Math.max(wrapLeft - hoverBoxLineThickness, Math.min(wrapRight - w + hoverBoxLineThickness, nameX))
        c.beginPath()
        c.arc(nameX + r, nameY + r, r, -Math.PI, -Math.PI / 2, false)
        c.arc(nameX + w - r, nameY + r, r, -Math.PI / 2, 0, false)
        c.arc(nameX + w - r, nameY + h - r, r, 0, Math.PI / 2, false)
        c.arc(nameX + r, nameY + h - r, r, Math.PI / 2, Math.PI, false)
        c.save()
        c.shadowColor = 'rgba(0, 0, 0, 0.5)'
        c.shadowOffsetY = 3
        c.shadowBlur = 10
        c.fillStyle = textColor
        c.fill()
        c.restore()
        c.fillStyle = backgroundColor
        c.fillText(text, nameX + textPaddingX, nameY + 0.7 * rowHeight)
      }

      // Draw the margin shadow
      if (scrollX > 0) {
        const gradient = c.createLinearGradient(x + margin, 0, x + margin + shadowWidth, 0)
        for (let i = 0; i <= 10; i++) {
          const t = i / 10
          gradient.addColorStop(t, `rgba(0, 0, 0, ${(1 - t) * (1 - t) * 0.2})`)
        }
        c.fillStyle = gradient
        c.fillRect(x + margin, y, shadowWidth, height)
      }

      // Draw the scrollbars
      if (scrollbarX) {
        const dx = x + margin + (scrollX / maxScrollX) * (scrollbarX.trackLength - scrollbarX.thumbLength)
        const dy = y + height - scrollbarThickness
        c.fillStyle = 'rgba(127, 127, 127, 0.5)'
        c.beginPath()
        c.arc(
          dx + scrollbarThickness / 2,
          dy + scrollbarThickness / 2,
          scrollbarThickness / 4,
          Math.PI / 2,
          (Math.PI * 3) / 2,
          false,
        )
        c.arc(
          dx + scrollbarX.thumbLength - scrollbarThickness / 2,
          dy + scrollbarThickness / 2,
          scrollbarThickness / 4,
          -Math.PI / 2,
          Math.PI / 2,
          false,
        )
        c.fill()
      }
      if (scrollbarY) {
        const dx = x + width - scrollbarThickness + 6
        const dy = y + (scrollY / maxScrollY) * (scrollbarY.trackLength - scrollbarY.thumbLength)
        c.fillStyle = 'rgba(90, 20, 140, 0.4)'
        c.beginPath()
        c.arc(dx + scrollbarThickness / 2, dy + scrollbarThickness / 2, scrollbarThickness / 4, -Math.PI, 0, false)
        c.arc(
          dx + scrollbarThickness / 2,
          dy + scrollbarY.thumbLength - scrollbarThickness / 2,
          scrollbarThickness / 4,
          0,
          Math.PI,
          false,
        )
        c.fill()
      }

      // Draw the margin
      c.fillStyle = 'rgba(80, 0, 40, 0.1)'
      c.fillRect(0, 0, margin, height)

      // c.fillStyle = 'rgba(0, 0, 0, 0.1)'
      // c.fillRect(x, y, margin, height)

      // c.fillStyle = '#220033'
      // c.fillRect(x + margin - 1, y, 1, height)

      c.textAlign = 'right'
      c.fillStyle = textColor
      c.font = '11px monospace'
      for (let i = firstLineIndex, n = wrappedRows.length; i <= lastLineIndex; i++) {
        const row = i < n ? wrappedRows[i] : wrappedRows[n - 1] + (i - (n - 1))
        if (row > lastRow) break
        const dx = x + margin - textPaddingX
        const dy = y - scrollY + textPaddingY + (row + 0.6) * rowHeight
        c.globalAlpha = i < lines.length ? 0.625 : 0.25
        c.fillText((i + 1).toString(), dx, dy)
      }
      c.font = monospaceFont
      c.globalAlpha = 1

      c.restore()
    },
  }
}

function draw() {
  requestAnimationFrame(draw)
  if (!isInvalid) return
  isInvalid = false

  c.clearRect(0, 0, innerWidth, innerHeight)
  if (!generatedTextArea) return

  const bodyStyle = getComputedStyle(document.body)
  if (originalTextArea) originalTextArea.draw(bodyStyle)
  generatedTextArea.draw(bodyStyle)

  // Draw the splitter
  c.fillStyle = 'rgba(0, 0, 0, 0.1)'
  c.fillRect((innerWidth >>> 1) - (splitterWidth >> 1), 0, splitterWidth, innerHeight)

  // Draw the arrow between the two hover areas
  if (hover?.mapping && originalTextArea && originalTextArea.sourceIndex === hover?.mapping.originalSource) {
    const originalHoverRect = originalTextArea.getHoverRect()
    const generatedHoverRect = generatedTextArea.getHoverRect()
    if (originalHoverRect && generatedHoverRect) {
      const textColor = bodyStyle.color
      const originalBounds = originalTextArea.bounds()
      const generatedBounds = generatedTextArea.bounds()
      const originalArrowHead = hover.sourceIndex === generatedTextArea.sourceIndex
      const generatedArrowHead = hover.sourceIndex === originalTextArea.sourceIndex
      const [ox, oy, ow, oh] = originalHoverRect
      const [gx, gy, , gh] = generatedHoverRect
      const x1 = Math.min(ox + ow, originalBounds.x + originalBounds.width) + (originalArrowHead ? 10 : 2)
      const x2 = Math.max(gx, generatedBounds.x + margin) - (generatedArrowHead ? 10 : 2)
      const y1 = oy + oh / 2
      const y2 = gy + gh / 2

      c.save()
      c.beginPath()
      c.rect(0, 0, innerWidth, innerHeight)
      // c.roundRect(0, 0, innerWidth, innerHeight, 90)
      // c.stroke()
      c.clip()

      // Draw the curve
      c.beginPath()
      c.moveTo(x1, y1)
      c.bezierCurveTo((x1 + 2 * x2) / 3 + margin / 2, y1, (x1 * 2 + x2) / 3 - margin / 2, y2, x2, y2)
      c.strokeStyle = textColor
      c.lineWidth = 2
      c.stroke()

      // Draw the arrow heads
      c.beginPath()
      if (originalArrowHead) {
        c.moveTo(x1 - 10, y1)
        c.lineTo(x1, y1 + 5)
        c.lineTo(x1, y1 - 5)
      }
      if (generatedArrowHead) {
        c.moveTo(x2 + 10, y2)
        c.lineTo(x2, y2 + 5)
        c.lineTo(x2, y2 - 5)
      }
      c.fillStyle = textColor
      c.fill()

      c.restore()
    }
  }
}

document.addEventListener('mousemove', e => {
  const oldHover = hover
  hover = null

  if (originalTextArea) originalTextArea.onmousemove(e)
  if (generatedTextArea) generatedTextArea.onmousemove(e)

  if (JSON.stringify(hover) !== JSON.stringify(oldHover)) {
    isInvalid = true
  }
})

document.addEventListener('mousedown', e => {
  if (originalTextArea) originalTextArea.onmousedown(e)
  if (generatedTextArea) generatedTextArea.onmousedown(e)
})

window.addEventListener('blur', () => {
  if (hover) {
    hover = null
    isInvalid = true
  }
})

function onresize() {
  const width = innerWidth
  const height = innerHeight
  const ratio = devicePixelRatio
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  c.scale(ratio, ratio)
  isInvalid = true
}

window.addEventListener('resize', onresize)

canvas.addEventListener(
  'wheel',
  e => {
    e.preventDefault()
    if (originalTextArea) originalTextArea.onwheel(e)
    if (generatedTextArea) generatedTextArea.onwheel(e)
  },
  { passive: false },
)

document.body.appendChild(canvas)
onresize()
draw()

////////////////////////////////////////////////////////////////////////////////
// Theme

const THEMES = ['light', 'dark']

document.body.dataset.theme = THEMES[Number(matchMedia('(prefers-color-scheme: dark)').matches)]

document.getElementById('theme-toggle').onclick = () => {
  document.body.dataset.theme = THEMES.find(x => x !== document.body.dataset.theme)
}

////////////////////////////////////////////////////////////////////////////////

const remoteSearchUrl = new URLSearchParams(window.location.search).get('url')
if (remoteSearchUrl) {
  const code = await fetch(remoteSearchUrl).then(r => r.text())
  finishLoading('', code)
}

const exampleJS = `// index.tsx
import { h as u, Fragment as l, render as c } from "preact";

// counter.tsx
import { h as t, Component as i } from "preact";
import { useState as a } from "preact/hooks";
var n = class extends i {
  constructor(e) {
    super(e);
    this.n = () => this.setState({ t: this.state.t + 1 });
    this.r = () => this.setState({ t: this.state.t - 1 });
    this.state.t = e.e;
  }
  render() {
    return t("div", {
      class: "counter"
    }, t("h1", null, this.props.label), t("p", null, t("button", {
      onClick: this.r
    }, "-"), " ", this.state.t, " ", t("button", {
      onClick: this.n
    }, "+")));
  }
}, s = (r) => {
  let [o, e] = a(r.e);
  return t("div", {
    class: "counter"
  }, t("h1", null, r.o), t("p", null, t("button", {
    onClick: () => e(o - 1)
  }, "-"), " ", o, " ", t("button", {
    onClick: () => e(o + 1)
  }, "+")));
};

// index.tsx
c(
  u(l, null, u(n, {
    o: "Counter 1",
    e: 100
  }), u(s, {
    o: "Counter 2",
    e: 200
  })),
  document.getElementById("root")
);
//# sourceMappingURL=example.js.map
`

const exampleMap = `{
  "version": 3,
  "sources": ["index.tsx", "counter.tsx"],
  "sourcesContent": ["import { h, Fragment, render } from 'preact'\\nimport { CounterClass, CounterFunction } from './counter'\\n\\nrender(\\n  <>\\n    <CounterClass label_=\\"Counter 1\\" initialValue_={100} />\\n    <CounterFunction label_=\\"Counter 2\\" initialValue_={200} />\\n  </>,\\n  document.getElementById('root')!,\\n)\\n", "import { h, Component } from 'preact'\\nimport { useState } from 'preact/hooks'\\n\\ninterface CounterProps {\\n  label_: string\\n  initialValue_: number\\n}\\n\\ninterface CounterState {\\n  value_: number\\n}\\n\\nexport class CounterClass extends Component<CounterProps, CounterState> {\\n  state: CounterState\\n\\n  constructor(props: CounterProps) {\\n    super(props)\\n    this.state.value_ = props.initialValue_\\n  }\\n\\n  increment_ = () => this.setState({ value_: this.state.value_ + 1 })\\n  decrement_ = () => this.setState({ value_: this.state.value_ - 1 })\\n\\n  render() {\\n    return <div class=\\"counter\\">\\n      <h1>{this.props.label}</h1>\\n      <p>\\n        <button onClick={this.decrement_}>-</button>\\n        {' '}\\n        {this.state.value_}\\n        {' '}\\n        <button onClick={this.increment_}>+</button>\\n      </p>\\n    </div>\\n  }\\n}\\n\\nexport let CounterFunction = (props: CounterProps) => {\\n  let [value, setValue] = useState(props.initialValue_)\\n  return <div class=\\"counter\\">\\n    <h1>{props.label_}</h1>\\n    <p>\\n      <button onClick={() => setValue(value - 1)}>-</button>\\n      {' '}\\n      {value}\\n      {' '}\\n      <button onClick={() => setValue(value + 1)}>+</button>\\n    </p>\\n  </div>\\n}\\n"],
  "mappings": ";AAAA,SAAS,KAAAA,GAAG,YAAAC,GAAU,UAAAC,SAAc;;;ACApC,SAAS,KAAAC,GAAG,aAAAC,SAAiB;AAC7B,SAAS,YAAAC,SAAgB;AAWlB,IAAMC,IAAN,cAA2BF,EAAsC;AAAA,EAGtE,YAAYG,GAAqB;AAC/B,UAAMA,CAAK;AAIb,SAAAC,IAAa,MAAM,KAAK,SAAS,EAAEC,GAAQ,KAAK,MAAMA,IAAS,EAAE,CAAC;AAClE,SAAAC,IAAa,MAAM,KAAK,SAAS,EAAED,GAAQ,KAAK,MAAMA,IAAS,EAAE,CAAC;AAJhE,SAAK,MAAMA,IAASF,EAAMI;AAAA,EAC5B;AAAA,EAKA,SAAS;AACP,WAAOR,EAAC;AAAA,MAAI,OAAM;AAAA,OAChBA,EAAC,YAAI,KAAK,MAAM,KAAM,GACtBA,EAAC,WACCA,EAAC;AAAA,MAAO,SAAS,KAAKO;AAAA,OAAY,GAAC,GAClC,KACA,KAAK,MAAMD,GACX,KACDN,EAAC;AAAA,MAAO,SAAS,KAAKK;AAAA,OAAY,GAAC,CACrC,CACF;AAAA,EACF;AACF,GAEWI,IAAkB,CAACL,MAAwB;AACpD,MAAI,CAACM,GAAOC,CAAQ,IAAIT,EAASE,EAAMI,CAAa;AACpD,SAAOR,EAAC;AAAA,IAAI,OAAM;AAAA,KAChBA,EAAC,YAAII,EAAMQ,CAAO,GAClBZ,EAAC,WACCA,EAAC;AAAA,IAAO,SAAS,MAAMW,EAASD,IAAQ,CAAC;AAAA,KAAG,GAAC,GAC5C,KACAA,GACA,KACDV,EAAC;AAAA,IAAO,SAAS,MAAMW,EAASD,IAAQ,CAAC;AAAA,KAAG,GAAC,CAC/C,CACF;AACF;;;AD9CAG;AAAA,EACEC,EAAAC,GAAA,MACED,EAACE,GAAA;AAAA,IAAaC,GAAO;AAAA,IAAYC,GAAe;AAAA,GAAK,GACrDJ,EAACK,GAAA;AAAA,IAAgBF,GAAO;AAAA,IAAYC,GAAe;AAAA,GAAK,CAC1D;AAAA,EACA,SAAS,eAAe,MAAM;AAChC;",
  "names": ["h", "Fragment", "render", "h", "Component", "useState", "CounterClass", "props", "increment_", "value_", "decrement_", "initialValue_", "CounterFunction", "value", "setValue", "label_", "render", "h", "Fragment", "CounterClass", "label_", "initialValue_", "CounterFunction"]
}
`
