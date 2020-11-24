// Volume manager implementation.

import { Nexus } from './nexus';
import { Replica } from './replica';
import { Volume, VolumeState } from './volume';

const EventEmitter = require('events');
const EventStream = require('./event_stream');
const { GrpcCode, GrpcError } = require('./grpc_client');
const log = require('./logger').Logger('volumes');

// Volume manager that emit events for new/modified/deleted volumes.
export class Volumes extends EventEmitter {
  private registry: any;
  private events: any; // stream of events from registry
  private volumes: Record<string, Volume>; // volumes indexed by uuid

  constructor (registry: any) {
    super();
    this.registry = registry;
    this.events = null;
    this.volumes = {};
  }

  start() {
    const self = this;
    this.events = new EventStream({ registry: this.registry });
    this.events.on('data', async function (ev: any) {
      if (ev.kind === 'pool' && ev.eventType === 'new') {
        // New pool was added and perhaps we have volumes waiting to schedule
        // their replicas on it.
        Object.values(self.volumes)
          .filter((v) => v.state === VolumeState.Degraded)
          .forEach((v) => v.fsa());
      } else if (ev.kind === 'replica' || ev.kind === 'nexus') {
        const uuid: string = ev.object.uuid;
        const volume = self.volumes[uuid];
        if (!volume) {
          // Ignore events for volumes that do not exist. Those might be events
          // related to a volume that is being destroyed.
          log.debug(`${ev.eventType} event for unknown volume "${uuid}"`);
          return;
        }
        if (ev.kind === 'replica') {
          if (ev.eventType === 'new') {
            volume.newReplica(ev.object);
          } else if (ev.eventType === 'mod') {
            volume.modReplica(ev.object);
          } else if (ev.eventType === 'del') {
            volume.delReplica(ev.object);
          }
        } else if (ev.kind === 'nexus') {
          if (ev.eventType === 'new') {
            volume.newNexus(ev.object);
          } else if (ev.eventType === 'mod') {
            volume.modNexus(ev.object);
          } else if (ev.eventType === 'del') {
            volume.delNexus(ev.object);
          }
        }
        self.emit('volume', {
          eventType: 'mod',
          object: volume
        });
      }
    });
  }

  stop() {
    this.events.destroy();
    this.events.removeAllListeners();
    this.events = null;
  }

  // Return a volume with specified uuid.
  //
  // @param   uuid   ID of the volume.
  // @returns Matching volume or undefined if not found.
  //
  get(uuid: string): Volume | undefined {
    return this.volumes[uuid];
  }

  // Return all volumes.
  list(): Volume[] {
    return Object.values(this.volumes);
  }

  // Create volume object (just the object) and add it to the internal list
  // of volumes. The method is idempotent. If a volume with the same uuid
  // already exists, then update its parameters.
  //
  // @param   {string}   uuid                 ID of the volume.
  // @param   {object}   spec                 Properties of the volume.
  // @params  {number}   spec.replicaCount    Number of desired replicas.
  // @params  {string[]} spec.preferredNodes  Nodes to prefer for scheduling replicas.
  // @params  {string[]} spec.requiredNodes   Replicas must be on these nodes.
  // @params  {number}   spec.requiredBytes   The volume must have at least this size.
  // @params  {number}   spec.limitBytes      The volume should not be bigger than this.
  // @params  {string}   spec.protocol        The share protocol for the nexus.
  // @returns {object}   New volume object.
  //
  async createVolume(uuid: string, spec: any): Promise<Volume> {
    if (!spec.requiredBytes || spec.requiredBytes < 0) {
      throw new GrpcError(
        GrpcCode.INVALID_ARGUMENT,
        'Required bytes must be greater than zero'
      );
    }
    let volume = this.volumes[uuid];
    if (volume) {
      if (volume.update(spec)) {
        // TODO: What to do if the size changes and is incompatible?
        this.emit('volume', {
          eventType: 'mod',
          object: volume
        });
        volume.fsa();
      }
    } else {
      volume = new Volume(uuid, this.registry, spec);
      // The volume starts to exist before it is created because we must receive
      // events for it and we want to show to user that it is being created.
      this.volumes[uuid] = volume;
      this.emit('volume', {
        eventType: 'new',
        object: volume
      });
      // check for components that already exist and assign them to the volume
      this.registry.getReplicaSet(uuid).forEach((r: Replica) => volume.newReplica(r));
      const nexus: Nexus = this.registry.getNexus(uuid);
      if (nexus) {
        volume.newNexus(nexus);
        return volume;
      }

      try {
        await volume.create();
      } catch (err) {
        // undo the pending state
        delete this.volumes[uuid];
        this.emit('volume', {
          eventType: 'del',
          object: volume
        });
        throw err;
      }
      volume.fsa();
    }
    return volume;
  }

  // Destroy the volume.
  //
  // The method is idempotent - if the volume does not exist it does not return
  // an error.
  //
  // @param   uuid            ID of the volume.
  //
  async destroyVolume(uuid: string) {
    const volume = this.volumes[uuid];
    if (!volume) return;

    await volume.destroy();
    delete this.volumes[uuid];
    this.emit('volume', {
      eventType: 'del',
      object: volume
    });
  }

  // Import the volume object (just the object) and add it to the internal list
  // of volumes. The method is idempotent. If a volume with the same uuid
  // already exists, then update its parameters.
  //
  // @param   {string}    uuid                 ID of the volume.
  // @param   {object}    spec                 Properties of the volume.
  // @params  {number}    spec.replicaCount    Number of desired replicas.
  // @params  {string[]}  spec.preferredNodes  Nodes to prefer for scheduling replicas.
  // @params  {string[]}  spec.requiredNodes   Replicas must be on these nodes.
  // @params  {number}    spec.requiredBytes   The volume must have at least this size.
  // @params  {number}    spec.limitBytes      The volume should not be bigger than this.
  // @params  {string}    spec.protocol        The share protocol for the nexus.
  // @params  {object}    status               Current properties of the volume
  // @params  {number}    status.size          Size of the volume.
  // @params  {string}    status.publishedOn   Node where the volume is published.
  // @returns {object}   New volume object.
  //
  importVolume(uuid: string, spec: any, status: any): Volume {
    let volume = this.volumes[uuid];

    if (volume) {
      if (volume.update(spec)) {
        this.emit('volume', {
          eventType: 'mod',
          object: volume
        });
        volume.fsa();
      }
    } else {
      volume = new Volume(uuid, this.registry, spec, status.size, status.publishedOn);
      this.volumes[uuid] = volume;

      // attach any associated replicas to the volume
      this.registry.getReplicaSet(uuid).forEach((r: Replica) => volume.newReplica(r));

      const nexus = this.registry.getNexus(uuid);
      if (nexus) {
        volume.newNexus(nexus);
      }

      this.emit('volume', {
        eventType: 'new',
        object: volume
      });
      volume.fsa();
    }
    return volume;
  }
}