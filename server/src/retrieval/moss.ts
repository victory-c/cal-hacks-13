// Moss local session indexes hot canonical facts; file storage remains the source of truth.
// https://docs.moss.dev/docs/reference/js/classes/SessionIndex
import { env, folderAllows } from "@canon/shared";
import type { Fact, Folder } from "@canon/shared";
import type { MossClient } from "@moss-js/moss";
import type { RetrievalHit, Retriever } from "./index.ts";

type MossSession = Pick<Awaited<ReturnType<MossClient["session"]>>, "addDocs" | "deleteDocs" | "query">;
type MossConnection = { session(name: string): Promise<MossSession>; close(): Promise<void> };

export class MossRetriever implements Retriever {
  readonly name = "moss";
  private client: MossConnection | undefined;
  private readonly projectId: string;
  private readonly projectKey: string;
  private session: Promise<MossSession> | undefined;
  private facts = new Map<string, Fact>();
  private indexed = new Set<string>();
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { projectId?: string; projectKey?: string; client?: MossConnection } = {}) {
    const id=opts.projectId ?? env("MOSS_PROJECT_ID");
    const key=opts.projectKey ?? env("MOSS_PROJECT_KEY");
    if (!opts.client && (!id || !key)) throw new Error("MossRetriever needs MOSS_PROJECT_ID and MOSS_PROJECT_KEY.");
    this.client=opts.client;
    this.projectId=id ?? "";
    this.projectKey=key ?? "";
  }

  // Serialize replacement and queries so a query never sees a partially replaced index.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result=this.queue.then(operation);
    this.queue=result.catch(()=>undefined);
    return result;
  }
  private open(): Promise<MossSession> {
    if (!this.session) this.session=(async()=>{
      // Keep offline/keyword startup independent of optional native bindings.
      if (!this.client) { const {MossClient}=await import("@moss-js/moss"); this.client=new MossClient(this.projectId,this.projectKey); }
      return this.client.session("canon-hot-facts");
    })().catch(error=>{this.session=undefined;throw error;});
    return this.session;
  }

  async index(facts: Fact[]): Promise<void> {
    const snapshot=facts.filter(fact=>fact.tier==="hot").map(fact=>({...fact}));
    return this.exclusive(async()=>{
      this.ready=false;
      const session=await this.open();
      const next=new Map(snapshot.map(fact=>[fact.id,fact]));
      // Track IDs before mutation: a partially failed write must still be retired on retry.
      const stale=[...this.indexed].filter(id=>!next.has(id));
      if (stale.length) { await session.deleteDocs(stale); for(const id of stale)this.indexed.delete(id); }
      const changed=snapshot.filter(fact=>JSON.stringify(this.facts.get(fact.id))!==JSON.stringify(fact));
      if (changed.length) {
        for(const fact of changed)this.indexed.add(fact.id);
        await session.addDocs(changed.map(fact=>({id:fact.id,text:`${fact.statement}\n${fact.detail??""}`,metadata:{folder:fact.folder}})),{upsert:true});
      }
      this.facts=next;
      this.ready=true;
    });
  }

  async search(query: string, opts: { folders: readonly Folder[]; k: number }): Promise<RetrievalHit[]> {
    return this.exclusive(async()=>{
      if (!this.ready) throw new Error("Moss index is not ready; retrieval is unavailable until indexing succeeds.");
      const k=Math.max(0,Math.floor(opts.k));
      if (!query.trim() || !Number.isFinite(k) || k===0) return [];
      const folders=[...new Set([...this.facts.values()].map(fact=>fact.folder))].filter(folder=>folderAllows(opts.folders,folder));
      if (!folders.length) return [];
      const session=await this.open();
      // Permissions are applied INSIDE Moss before its topK ranking, then checked again by ID.
      const result=await session.query(query,{topK:k,alpha:0.6,filter:{field:"folder",condition:{$in:folders}}});
      const seen=new Set<string>();
      const hits: RetrievalHit[]=[];
      for(const doc of result.docs) {
        const fact=this.facts.get(doc.id);
        if(!fact || seen.has(doc.id) || !folderAllows(opts.folders,fact.folder) || !Number.isFinite(doc.score))continue;
        seen.add(doc.id);hits.push({fact,score:doc.score});
      }
      return hits.slice(0,k);
    });
  }

  async close(): Promise<void> { await this.exclusive(async()=>{ await this.client?.close(); }); }
}
