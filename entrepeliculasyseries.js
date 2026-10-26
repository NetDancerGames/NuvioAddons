/**
 * Plugin de Nuvio para EntrePeliculasySeries
 * Compatible con el runtime Hermes JS de Nuvio.
 */

const BASE_URL = 'https://entrepeliculasyseries.nz';
const TMDB_API_KEY = 'a89c31fa741639d48b1d9ed328b9fb63'; // TMDB key pública para resolver metas

/**
 * Función auxiliar para peticiones HTTP con Timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'es-ES,es;q=0.9',
                ...(options.headers || {})
            }
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

/**
 * Obtiene el título en español e inglés desde TMDB usando el id entregado por Nuvio
 */
async function getTmdbMeta(id, type) {
    try {
        const mediaType = type === 'movie' ? 'movie' : 'tv';
        const url = `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${TMDB_API_KEY}&language=es-ES`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) return null;
        const data = await res.json();
        
        const title = type === 'movie' ? (data.title || data.original_title) : (data.name || data.original_name);
        const originalTitle = type === 'movie' ? data.original_title : data.original_name;
        const releaseYear = (data.release_date || data.first_air_date || '').split('-')[0];

        return { title, originalTitle, year: releaseYear };
    } catch (e) {
        return null;
    }
}

/**
 * Limpia y normaliza cadenas de texto para comparaciones
 */
function cleanTitle(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extrae enlaces incrustados de reproductores (embeds / iFrames / enlaces directos)
 */
function extractEmbedUrls(html) {
    const streamUrls = [];
    const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let match;

    while ((match = iframeRegex.exec(html)) !== null) {
        let src = match[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src.startsWith('http')) {
            streamUrls.push(src);
        }
    }

    // Extracción de variables o datos data-src
    const dataSrcRegex = /data-src=["']([^"']+)["']/gi;
    while ((match = dataSrcRegex.exec(html)) !== null) {
        let src = match[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src.startsWith('http')) {
            streamUrls.push(src);
        }
    }

    return [...new Set(streamUrls)];
}

/**
 * Función principal requerida por Nuvio
 * @param {string} id - ID de TMDB (ej. "550" o "tt1375666")
 * @param {string} type - "movie" o "tv"
 * @param {string|number} [season] - Número de temporada (si es serie)
 * @param {string|number} [episode] - Número de episodio (si es serie)
 */
async function getStreams(id, type, season, episode) {
    const streams = [];

    try {
        // 1. Obtener metadatos de TMDB
        const meta = await getTmdbMeta(id, type);
        if (!meta || !meta.title) return [];

        const searchQueries = [meta.title];
        if (meta.originalTitle && meta.originalTitle !== meta.title) {
            searchQueries.push(meta.originalTitle);
        }

        let targetPageUrl = null;

        // 2. Buscar el título en la web
        for (const query of searchQueries) {
            const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
            const res = await fetchWithTimeout(searchUrl);
            if (!res.ok) continue;

            const html = await res.text();
            
            // Coincidencia mediante expresiones regulares en las entradas de búsqueda
            const articleRegex = /<article[^>]*>[\s\S]*?<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>[\s\S]*?<\/article>/gi;
            let match;

            while ((match = articleRegex.exec(html)) !== null) {
                const itemUrl = match[1];
                const itemTitle = match[2].replace(/<[^>]+>/g, '');

                const cleanedTarget = cleanTitle(query);
                const cleanedFound = cleanTitle(itemTitle);

                if (cleanedFound.includes(cleanedTarget)) {
                    targetPageUrl = itemUrl;
                    break;
                }
            }

            if (targetPageUrl) break;
        }

        if (!targetPageUrl) return [];

        // 3. Procesar la página encontrada
        let pageUrlToFetch = targetPageUrl;

        // Si es una serie, formatear la ruta o buscar el capítulo específico
        if (type === 'tv' && season && episode) {
            const epUrl = targetPageUrl.replace(/\/$/, '') + `-temporada-${season}-capitulo-${episode}/`;
            const epRes = await fetchWithTimeout(epUrl);
            if (epRes.ok) {
                pageUrlToFetch = epUrl;
            }
        }

        const pageRes = await fetchWithTimeout(pageUrlToFetch);
        if (!pageRes.ok) return [];

        const pageHtml = await pageRes.text();

        // 4. Extraer enlaces de reproducción
        const embeds = extractEmbedUrls(pageHtml);

        embeds.forEach((embedUrl, index) => {
            let quality = '720p';
            if (pageHtml.includes('1080p') || embedUrl.includes('1080')) quality = '1080p';

            let serverName = 'EntrePeliculasySeries';
            try {
                const hostname = new URL(embedUrl).hostname.replace('www.', '');
                serverName = hostname.split('.')[0];
                serverName = serverName.charAt(0).toUpperCase() + serverName.slice(1);
            } catch (e) {}

            streams.push({
                name: `EntrePeliculasySeries`,
                title: `Servidor: ${serverName}\nCalidad: ${quality} (ES/LAT)`,
                url: embedUrl,
                quality: quality,
                headers: {
                    'Referer': BASE_URL
                }
            });
        });

    } catch (err) {
        // En caso de error se retorna lista vacía (regla de oro del runtime)
        return [];
    }

    return streams;
}

// Exportación compatible con el sandbox Hermes / Nuvio
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
}
if (typeof globalThis !== 'undefined') {
    globalThis.getStreams = getStreams;
}
if (typeof global !== 'undefined') {
    global.getStreams = getStreams;
}
