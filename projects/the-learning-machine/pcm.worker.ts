import { exposePcmGenerator } from '../../src/engine/worker-pcm';
import { renderPcm } from './score';
exposePcmGenerator(({startFrame,frames,sampleRate,trackId},signal)=>{signal.throwIfAborted();return renderPcm(trackId,startFrame,frames,sampleRate,signal);});
