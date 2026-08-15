'use strict';

/* Quick smoke test for lib/fernet.js + lib/site-client.js (run in plain Node). */

const { SiteClient, MOVIE_TIME_PATH } = require('./lib/site-client');
const { fernetDecrypt } = require('./lib/fernet');

function log(label, value) {
  if (value && typeof value === 'object' && value.map) {
    console.log(`\n[${label}] count=${value.length}`);
    value.slice(0, 3).forEach((v, i) => {
      console.log(
        `  ${i}: title=${v.title} url=${(v.url || '').slice(0, 60)} poster=${(v.poster || '').slice(0, 40)} meta=${v.remarks || ''}`
      );
    });
  } else {
    console.log(`\n[${label}]`, value);
  }
}

(async () => {
  const client = new SiteClient();

  try {
    const home = await client.fetchCatalog('/');
    log('home catalog', home);
  } catch (e) {
    console.log('[home catalog] FAILED:', e.message);
  }

  try {
    const movies = await client.fetchCatalog(MOVIE_TIME_PATH);
    log('movies catalog', movies);
    if (movies.length) {
      const detail = await client.fetchDetail(movies[0]);
      log('movie detail', {
        title: detail.title,
        meta: detail.meta,
        episodes: detail.episodes.length,
      });
      if (detail.episodes.length) {
        const target = await client.resolvePlayTarget(detail.episodes[0]);
        log('resolve target', target);
      }
    }
  } catch (e) {
    console.log('[movies flow] FAILED:', e.message);
  }

  try {
    const peach = await client.fetchPeachCatalog(1);
    log('peach catalog', peach);
    if (peach.length) {
      const pd = await client.fetchPeachDetail(peach[0]);
      log('peach detail', {
        title: pd.title,
        episodes: pd.episodes.length,
        first: pd.episodes[0] ? pd.episodes[0].path : '',
      });
    }
  } catch (e) {
    console.log('[peach flow] FAILED:', e.message);
  }

  console.log('\nDONE');
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
