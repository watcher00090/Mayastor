// Unit tests for the volume object
//
// The tests for more complex volume methods are in volumes_test.js mainly
// because volumes.js takes care of routing registry events to the volume
// and it makes sense to test this together.

'use strict';

const expect = require('chai').expect;
const sinon = require('sinon');
const { Nexus } = require('../nexus');
const { Node } = require('../node');
const { Pool } = require('../pool');
const Registry = require('../registry');
const { Replica } = require('../replica');
const { Volume } = require('../volume');
const { shouldFailWith } = require('./utils');
const { GrpcCode } = require('../grpc_client');

const UUID = 'ba5e39e9-0c0e-4973-8a3a-0dccada09cbb';

const defaultOpts = {
  replicaCount: 1,
  preferredNodes: [],
  requiredNodes: [],
  requiredBytes: 100,
  limitBytes: 100
};

// Repeating code that is extracted to a function.
function createFakeVolume (state) {
  const registry = new Registry();
  const volume = new Volume(UUID, registry, defaultOpts, 100);
  const fsaStub = sinon.stub(volume, 'fsa');
  fsaStub.returns();
  const node = new Node('node');
  const replica = new Replica({ uuid: UUID, size: 100, share: 'REPLICA_NONE', uri: `bdev:///${UUID}` });
  const pool = new Pool({ name: 'pool', disks: [] });
  pool.bind(node);
  replica.bind(pool);
  volume.newReplica(replica);
  volume.state = state;
  return [volume, node];
}

module.exports = function () {
  it('should stringify volume name', () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts);
    expect(volume.toString()).to.equal(UUID);
  });

  it('should get name of the node where the volume has been published', () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts, 100, 'node');
    expect(volume.getNodeName()).to.equal('node');
  });

  it('should get zero size of a volume that has not been created yet', () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts);
    expect(volume.getSize()).to.equal(0);
  });

  it('should get the right size of a volume that has been imported', () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts, 100);
    expect(volume.getSize()).to.equal(100);
  });

  it('should set the preferred nodes for the volume', () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts);
    const fsaStub = sinon.stub(volume, 'fsa');
    fsaStub.returns();
    expect(volume.preferredNodes).to.have.lengthOf(0);
    const updated = volume.update({ preferredNodes: ['node1', 'node2'] });
    expect(updated).to.equal(true);
    expect(volume.preferredNodes).to.have.lengthOf(2);
  });

  it('should not publish volume that is known to be broken', async () => {
    const registry = new Registry();
    const volume = new Volume(UUID, registry, defaultOpts, 100);
    const fsaStub = sinon.stub(volume, 'fsa');
    fsaStub.returns();
    volume.state = 'faulted';
    const node = new Node('node');
    const stub = sinon.stub(node, 'call');
    stub.onCall(0).resolves({});
    stub.onCall(1).resolves({ deviceUri: 'file:///dev/nbd0' });

    shouldFailWith(GrpcCode.INTERNAL, async () => {
      await volume.publish('nbd');
    });
    sinon.assert.notCalled(stub);
  });

  it('should publish a volume', async () => {
    const [volume, node] = createFakeVolume('healthy');
    const stub = sinon.stub(node, 'call');
    stub.onCall(0).resolves({ uuid: UUID, size: 100, state: 'NEXUS_ONLINE', children: [{ uri: `bdev:///${UUID}`, state: 'CHILD_ONLINE' }] });
    stub.onCall(1).resolves({ deviceUri: 'file:///dev/nbd0' });

    const uri = await volume.publish('nbd');
    expect(uri).to.equal('file:///dev/nbd0');
    sinon.assert.calledTwice(stub);
    sinon.assert.calledWithMatch(stub.firstCall, 'createNexus', {
      uuid: UUID,
      size: 100,
      children: [`bdev:///${UUID}`]
    });
    sinon.assert.calledWithMatch(stub.secondCall, 'publishNexus', {
      uuid: UUID,
      key: ''
    });
  });

  it('should publish a volume that already has a nexus', async () => {
    const [volume, node] = createFakeVolume('healthy');
    const stub = sinon.stub(node, 'call');
    const nexus = new Nexus({ uuid: UUID });
    nexus.bind(node);
    volume.newNexus(nexus);

    stub.resolves({ deviceUri: 'file:///dev/nbd0' });
    const uri = await volume.publish('nbd');
    expect(uri).to.equal('file:///dev/nbd0');
    expect(nexus.deviceUri).to.equal('file:///dev/nbd0');
    sinon.assert.calledOnce(stub);
    sinon.assert.calledWithMatch(stub, 'publishNexus', {
      uuid: UUID,
      key: ''
    });
  });

  it('should publish a volume that has been already published', async () => {
    const [volume, node] = createFakeVolume('degraded');
    const stub = sinon.stub(node, 'call');
    const nexus = new Nexus({ uuid: UUID });
    const getUriStub = sinon.stub(nexus, 'getUri');
    nexus.bind(node);
    volume.newNexus(nexus);
    getUriStub.returns('file:///dev/nbd0');

    const uri = await volume.publish('nbd');
    expect(uri).to.equal('file:///dev/nbd0');
    sinon.assert.notCalled(stub);
    sinon.assert.calledOnce(getUriStub);
  });

  it('should unpublish a volume', async () => {
    const [volume, node] = createFakeVolume('faulted');
    const stub = sinon.stub(node, 'call');
    const nexus = new Nexus({ uuid: UUID });
    const getUriStub = sinon.stub(nexus, 'getUri');
    nexus.bind(node);
    volume.newNexus(nexus);
    getUriStub.returns('file:///dev/nbd0');
    stub.onCall(0).resolves({});
    stub.onCall(1).resolves({});

    await volume.unpublish();
    expect(volume.getNodeName()).to.be.undefined();
    sinon.assert.calledTwice(stub);
    sinon.assert.calledWithMatch(stub.firstCall, 'unpublishNexus', {
      uuid: UUID
    });
    sinon.assert.calledWithMatch(stub.secondCall, 'destroyNexus', {
      uuid: UUID
    });
  });

  it('should unpublish volume that has not been published', async () => {
    const [volume, node] = createFakeVolume('faulted');
    const stub = sinon.stub(node, 'call');
    const nexus = new Nexus({ uuid: UUID });
    const getUriStub = sinon.stub(nexus, 'getUri');
    nexus.bind(node);
    volume.newNexus(nexus);
    getUriStub.returns();
    stub.resolves({});

    await volume.unpublish();
    expect(volume.getNodeName()).to.be.undefined();
    sinon.assert.calledOnce(stub);
    sinon.assert.calledWithMatch(stub, 'destroyNexus', {
      uuid: UUID
    });
  });

  it('should unpublish volume without nexus', async () => {
    const [volume, node] = createFakeVolume('healthy');
    const stub = sinon.stub(node, 'call');
    stub.resolves({});

    await volume.unpublish();
    expect(volume.getNodeName()).to.be.undefined();
    sinon.assert.notCalled(stub);
  });
};
