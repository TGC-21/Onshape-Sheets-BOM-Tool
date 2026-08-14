import { Hono } from 'hono'
import { deleteVendorListing, findListings, findListingsBatch, initCatalog, listCatalog, upsertCatalogPart } from '../lib/catalog.js'
const route=new Hono()
route.get('/',async c=>{try{await initCatalog();return c.json({parts:await listCatalog({search:c.req.query('search')||'',limit:Number(c.req.query('limit'))||100,offset:Number(c.req.query('offset'))||0})})}catch(e){return c.json({error:e.message},500)}})
route.post('/',async c=>{try{await initCatalog();return c.json({ok:true,part:await upsertCatalogPart(await c.req.json())})}catch(e){return c.json({error:e.message},400)}})
route.post('/csv',async c=>{try{await initCatalog();const b=await c.req.json();let n=0;for(const row of b.rows||[]){await upsertCatalogPart(row);n++}return c.json({ok:true,upserted:n})}catch(e){return c.json({error:e.message},400)}})
route.delete('/listings/:id', async (c) => { try { await initCatalog(); return c.json({ ok: true, listing: await deleteVendorListing(c.req.param('id')) }) } catch (e) { return c.json({ error: e.message }, 400) } })
route.get('/matches', async (c) => { try { await initCatalog(); return c.json({ listings: await findListings(c.req.query('partNumber')) }) } catch (e) { return c.json({ error: e.message }, 500) } })
route.post('/matches', async (c) => { try { await initCatalog(); return c.json({ matches: await findListingsBatch((await c.req.json()).partNumbers) }) } catch (e) { return c.json({ error: e.message }, 400) } })
export default route
