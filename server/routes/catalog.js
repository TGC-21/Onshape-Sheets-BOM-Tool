import { Hono } from 'hono'
import { initCatalog, listCatalog, upsertCatalogPart } from '../lib/catalog.js'
const route=new Hono()
route.get('/',async c=>{try{await initCatalog();return c.json({parts:await listCatalog()})}catch(e){return c.json({error:e.message},500)}})
route.post('/',async c=>{try{await initCatalog();return c.json({ok:true,part:await upsertCatalogPart(await c.req.json())})}catch(e){return c.json({error:e.message},400)}})
route.post('/csv',async c=>{try{await initCatalog();const b=await c.req.json();let n=0;for(const row of b.rows||[]){await upsertCatalogPart(row);n++}return c.json({ok:true,upserted:n})}catch(e){return c.json({error:e.message},400)}})
export default route
