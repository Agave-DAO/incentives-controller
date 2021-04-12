import { expect } from 'chai';
import rawHRE from 'hardhat';
import { BigNumber } from 'ethers';
import { formatEther, parseEther, parseUnits } from 'ethers/lib/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { JsonRpcSigner } from '@ethersproject/providers';

import { DRE, waitForTx } from '../helpers/misc-utils';
import {
  evmSnapshot,
  increaseTime,
  evmRevert,
  latestBlock,
  advanceBlockTo,
  impersonateAccountsHardhat,
} from '../helpers/misc-utils';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../helpers/constants';
import { IERC20 } from '../types/IERC20';
import { IAaveGovernanceV2 } from '../types/IAaveGovernanceV2';
import { ILendingPool } from '../types/ILendingPool';
import {
  StakedTokenIncentivesControllerFactory,
  AaveProtocolDataProviderFactory,
  AToken,
  ATokenFactory,
  InitializableAdminUpgradeabilityProxyFactory,
  ProposalIncentivesExecutorFactory,
  SelfdestructTransferFactory,
  VariableDebtTokenFactory,
} from '../types';
import { parse } from 'dotenv/types';
import { tEthereumAddress } from '../helpers/types';
import { ILendingPoolAddressesProviderFactory } from '../types/ILendingPoolAddressesProviderFactory';
import { IERC20Factory } from '../types/IERC20Factory';
import { IATokenFactory } from '../types/IATokenFactory';

const {
  RESERVES = 'DAI,GUSD,USDC,USDT,WBTC,WETH',
  POOL_CONFIGURATOR = '0x311bb771e4f8952e6da169b425e7e92d6ac45756',
  POOL_PROVIDER = '0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5',
  POOL_DATA_PROVIDER = '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d',
  ECO_RESERVE = '0x25F2226B597E8F9514B3F68F00f494cF4f286491',
  AAVE_TOKEN = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
  TREASURY = '0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c',
  IPFS_HASH = 'QmT9qk3CRYbFDWpDFYeAv8T8H1gnongwKhh5J68NLkLir6',
  AAVE_GOVERNANCE_V2 = '0xEC568fffba86c094cf06b22134B23074DFE2252c', // mainnet
  AAVE_SHORT_EXECUTOR = '0xee56e2b3d491590b5b31738cc34d5232f378a8d5', // mainnet
} = process.env;

if (
  !RESERVES ||
  !POOL_CONFIGURATOR ||
  !POOL_DATA_PROVIDER ||
  !ECO_RESERVE ||
  !AAVE_TOKEN ||
  !IPFS_HASH ||
  !AAVE_GOVERNANCE_V2 ||
  !AAVE_SHORT_EXECUTOR ||
  !TREASURY
) {
  throw new Error('You have not set correctly the .env file, make sure to read the README.md');
}

const AAVE_LENDING_POOL = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
const VOTING_DURATION = 19200;

const AAVE_WHALE = '0x25f2226b597e8f9514b3f68f00f494cf4f286491';

const AAVE_STAKE = '0x4da27a545c0c5B758a6BA100e3a049001de870f5';
const DAI_TOKEN = '0x6b175474e89094c44da98b954eedeac495271d0f';
const DAI_HOLDER = '0x72aabd13090af25dbb804f84de6280c697ed1150';

const spendList = {
  DAI: {
    holder: '0x72aabd13090af25dbb804f84de6280c697ed1150',
    transfer: '1000',
    deposit: '100',
    decimals: '18',
  },
  GUSD: {
    holder: '0x3e6722f32cbe5b3c7bd3dca7017c7ffe1b9e5a2a',
    transfer: '1000',
    deposit: '100',
    decimals: '2',
  },
  USDC: {
    holder: '0xAe2D4617c862309A3d75A0fFB358c7a5009c673F',
    transfer: '1000',
    deposit: '100',
    decimals: '6',
  },
  USDT: {
    holder: '0x9f57dc21f521c64204b6190c3076a05b559b1a28',
    transfer: '1000',
    deposit: '100',
    decimals: '6',
  },
  WBTC: {
    holder: '0x6dab3bcbfb336b29d06b9c793aef7eaa57888922',
    transfer: '1',
    deposit: '0.5',
    decimals: '8',
  },
  WETH: {
    holder: '0x0f4ee9631f4be0a63756515141281a3e2b293bbe',
    transfer: '1',
    deposit: '0.5',
    decimals: '18',
  },
};

describe('Enable incentives in target assets', () => {
  let ethers;

  let whale: JsonRpcSigner;
  let daiHolder: JsonRpcSigner;
  let proposer: SignerWithAddress;
  let incentivesProxyAdmin: SignerWithAddress;
  let incentivesProxy: tEthereumAddress;
  let gov: IAaveGovernanceV2;
  let pool: ILendingPool;
  let aave: IERC20;
  let stkAave: IERC20;
  let dai: IERC20;
  let aDAI: AToken;
  let variableDebtDAI: IERC20;
  let snapshotId: string;
  let proposalId: BigNumber;
  let aTokensImpl: tEthereumAddress[];
  let variableDebtTokensImpl: tEthereumAddress[];
  let proposalExecutionPayload: tEthereumAddress;
  /*
  afterEach(async () => {
    evmRevert(snapshotId);
    snapshotId = await evmSnapshot();
  });
*/
  before(async () => {
    await rawHRE.run('set-DRE');
    ethers = DRE.ethers;
    [proposer, incentivesProxyAdmin] = await DRE.ethers.getSigners();

    // Deploy incentives implementation
    const { address: incentivesImplementation } = await DRE.deployments.deploy(
      'StakedTokenIncentivesController',
      {
        from: proposer.address,
        args: [AAVE_STAKE, AAVE_SHORT_EXECUTOR],
      }
    );
    const incentivesInitParams = StakedTokenIncentivesControllerFactory.connect(
      incentivesImplementation,
      proposer
    ).interface.encodeFunctionData('initialize');

    // Deploy incentives proxy (Proxy Admin should be the provider, TBD)
    const { address: incentivesProxyAddress } = await DRE.deployments.deploy(
      'InitializableAdminUpgradeabilityProxy',
      {
        from: proposer.address,
        args: [],
      }
    );
    incentivesProxy = incentivesProxyAddress;

    // Initialize proxy for incentives controller
    const incentivesProxyInstance = InitializableAdminUpgradeabilityProxyFactory.connect(
      incentivesProxy,
      proposer
    );
    await waitForTx(
      await incentivesProxyInstance['initialize(address,address,bytes)'](
        incentivesImplementation,
        incentivesProxyAdmin.address,
        incentivesInitParams
      )
    );

    // Deploy aTokens and debt tokens
    const { aTokens, variableDebtTokens } = await rawHRE.run('deploy-reserve-implementations', {
      provider: POOL_PROVIDER,
      assets: RESERVES,
      incentivesController: incentivesProxy,
      treasury: TREASURY,
    });

    aTokensImpl = [...aTokens];
    variableDebtTokensImpl = [...variableDebtTokens];

    // Deploy Proposal Executor Payload
    const {
      address: proposalExecutionPayloadAddress,
    } = await new ProposalIncentivesExecutorFactory(proposer).deploy();
    proposalExecutionPayload = proposalExecutionPayloadAddress;
    // Send ether to the AAVE_WHALE, which is a non payable contract via selfdestruct
    const selfDestructContract = await new SelfdestructTransferFactory(proposer).deploy();
    await (
      await selfDestructContract.destroyAndTransfer(AAVE_WHALE, {
        value: ethers.utils.parseEther('1'),
      })
    ).wait();
    await impersonateAccountsHardhat([
      AAVE_WHALE,
      ...Object.keys(spendList).map((k) => spendList[k].holder),
    ]);

    // Impersonating holders
    whale = ethers.provider.getSigner(AAVE_WHALE);
    daiHolder = ethers.provider.getSigner(DAI_HOLDER);

    // Initialize contracts and tokens
    gov = (await ethers.getContractAt(
      'IAaveGovernanceV2',
      AAVE_GOVERNANCE_V2,
      proposer
    )) as IAaveGovernanceV2;
    pool = (await ethers.getContractAt(
      'ILendingPool',
      AAVE_LENDING_POOL,
      proposer
    )) as ILendingPool;

    const {
      configuration: { data },
      aTokenAddress,
      variableDebtTokenAddress,
    } = await pool.getReserveData(DAI_TOKEN);

    aave = IERC20Factory.connect(AAVE_TOKEN, whale);
    stkAave = IERC20Factory.connect(AAVE_STAKE, proposer);
    dai = IERC20Factory.connect(DAI_TOKEN, daiHolder);
    aDAI = ATokenFactory.connect(aTokenAddress, proposer);
    variableDebtDAI = IERC20Factory.connect(variableDebtTokenAddress, proposer);

    // Transfer enough AAVE to proposer
    await (await aave.transfer(proposer.address, parseEther('1000000'))).wait();

    // Transfer DAI to repay future DAI loan
    await (await dai.transfer(proposer.address, parseEther('100000'))).wait();
  });

  it('Proposal should be created', async () => {
    // Submit proposal
    proposalId = await gov.getProposalsCount();
    await DRE.run('propose-incentives', {
      proposalExecutionPayload,
      incentivesProxy,
      aTokens: aTokensImpl.join(','),
      variableDebtTokens: variableDebtTokensImpl.join(','),
      aaveGovernance: AAVE_GOVERNANCE_V2,
      shortExecutor: AAVE_SHORT_EXECUTOR,
      ipfsHash: IPFS_HASH,
    });

    // Mine block due flash loan voting protection
    await advanceBlockTo((await latestBlock()) + 1);

    // Submit vote and advance block to Queue phase
    await (await gov.submitVote(proposalId, true)).wait();
    await advanceBlockTo((await latestBlock()) + VOTING_DURATION + 1);
  });
  it('Proposal should be queued', async () => {
    // Queue and advance block to Execution phase
    await (await gov.queue(proposalId)).wait();
    let proposalState = await gov.getProposalState(proposalId);
    expect(proposalState).to.be.equal(5);

    await increaseTime(86400 + 10);
  });

  it('Proposal should be executed', async () => {
    // Execute payload
    await (await gov.execute(proposalId)).wait();
    console.log('Proposal executed');

    const proposalState = await gov.getProposalState(proposalId);
    expect(proposalState).to.be.equal(7);
  });

  it('Users should be able to deposit DAI at Lending Pool', async () => {
    // Deposit DAI to LendingPool
    await (await dai.connect(proposer).approve(pool.address, parseEther('2000'))).wait();

    const tx = await pool.deposit(dai.address, parseEther('100'), proposer.address, 0);
    expect(tx).to.emit(pool, 'Deposit');
    expect(await aDAI.balanceOf(proposer.address)).to.be.gte(parseEther('100'));
  });
  it('Users should be able to request DAI loan from Lending Pool', async () => {
    // Request DAI loan to LendingPool
    const tx = await pool.borrow(dai.address, parseEther('1'), '2', '0', proposer.address);
    expect(tx).to.emit(pool, 'Borrow');
    expect(await variableDebtDAI.balanceOf(proposer.address)).to.be.eq(parseEther('1'));
  });
  it('Users should be able to repay DAI loan from Lending Pool', async () => {
    const {
      configuration: { data },
      variableDebtTokenAddress,
    } = await pool.getReserveData(DAI_TOKEN);

    // Repay DAI variable loan to LendingPool
    await (await dai.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
    const tx = await pool.repay(dai.address, MAX_UINT_AMOUNT, '2', proposer.address);
    expect(tx).to.emit(pool, 'Repay');
  });
  it('Users should be able to withdraw DAI from Lending Pool', async () => {
    const {
      configuration: { data },
      aTokenAddress,
    } = await pool.getReserveData(DAI_TOKEN);

    // Withdraw DAI from LendingPool
    const priorDAIBalance = await dai.balanceOf(proposer.address);
    await (await aDAI.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
    const tx = await pool.withdraw(dai.address, MAX_UINT_AMOUNT, proposer.address);
    expect(tx).to.emit(pool, 'Withdraw');
    const afterDAIBalance = await dai.balanceOf(proposer.address);
    expect(await aDAI.balanceOf(proposer.address)).to.be.eq('0');
    expect(afterDAIBalance).to.be.gt(priorDAIBalance);
  });
  it('User should be able to interact with LendingPool with DAI/GUSD/USDC/USDT/WBTC/WETH', async () => {
    const poolProvider = await ILendingPoolAddressesProviderFactory.connect(
      POOL_PROVIDER,
      proposer
    );
    const protocolDataProvider = await AaveProtocolDataProviderFactory.connect(
      await poolProvider.getAddress(
        '0x0100000000000000000000000000000000000000000000000000000000000000'
      ),
      proposer
    );

    const reserveConfigs = (await protocolDataProvider.getAllReservesTokens())
      .filter(({ symbol }) => RESERVES.includes(symbol))
      .sort(({ symbol: a }, { symbol: b }) => a.localeCompare(b));

    // Deposit AAVE to LendingPool to have enought collateral for future borrows
    await (await aave.connect(proposer).approve(pool.address, parseEther('1000'))).wait();
    await (
      await pool.connect(proposer).deposit(aave.address, parseEther('1000'), proposer.address, 0)
    ).wait();

    for (let x = 0; x < reserveConfigs.length; x++) {
      const { aTokenAddress, variableDebtTokenAddress } = await pool.getReserveData(DAI_TOKEN);
      const { symbol, tokenAddress } = reserveConfigs[x];
      const reserve = IERC20Factory.connect(tokenAddress, proposer);
      const aToken = ATokenFactory.connect(aTokenAddress, proposer);
      const holderSigner = ethers.provider.getSigner(spendList[symbol].holder);

      // Transfer assets to proposer from reserve holder
      await (
        await reserve
          .connect(holderSigner)
          .transfer(
            proposer.address,
            parseUnits(spendList[symbol].transfer, spendList[symbol].decimals)
          )
      ).wait();

      // Amounts
      const depositAmount = parseUnits(spendList[symbol].deposit, spendList[symbol].decimals);
      const borrowAmount = depositAmount.div('10');

      // Deposit to LendingPool
      await (await reserve.connect(proposer).approve(pool.address, depositAmount)).wait();
      const tx1 = await pool
        .connect(proposer)
        .deposit(reserve.address, depositAmount, proposer.address, 0);
      await tx1.wait();
      expect(tx1).to.emit(pool, 'Deposit');

      // Request loan to LendingPool
      const tx2 = await pool.borrow(reserve.address, borrowAmount, '2', '0', proposer.address);
      await tx2.wait();
      expect(tx2).to.emit(pool, 'Borrow');

      // Repay variable loan to LendingPool
      await (await reserve.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
      const tx3 = await pool.repay(reserve.address, MAX_UINT_AMOUNT, '2', proposer.address);
      await tx3.wait();
      expect(tx3).to.emit(pool, 'Repay');

      // Withdraw from LendingPool
      const priorBalance = await reserve.balanceOf(proposer.address);
      await (await aToken.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
      const tx4 = await pool.withdraw(reserve.address, MAX_UINT_AMOUNT, proposer.address);
      await tx4.wait();
      expect(tx4).to.emit(pool, 'Withdraw');

      const afterBalance = await reserve.balanceOf(proposer.address);
      expect(await aToken.balanceOf(proposer.address)).to.be.eq('0');
      expect(afterBalance).to.be.gt(priorBalance);
    }
  });
  xit('Check all aToken symbols and debt token matches', async () => {
    const poolProvider = await ILendingPoolAddressesProviderFactory.connect(
      POOL_PROVIDER,
      proposer
    );
    const protocolDataProvider = await AaveProtocolDataProviderFactory.connect(
      await poolProvider.getAddress(
        '0x0100000000000000000000000000000000000000000000000000000000000000'
      ),
      proposer
    );

    const reserveConfigs = (await protocolDataProvider.getAllReservesTokens())
      .filter(({ symbol }) => RESERVES.includes(symbol))
      .sort(({ symbol: a }, { symbol: b }) => a.localeCompare(b));

    console.log('prior');
    for (let x = 0; x < reserveConfigs.length; x++) {
      const { aTokenAddress, variableDebtTokenAddress } = await pool.getReserveData(DAI_TOKEN);
      const { symbol, tokenAddress } = reserveConfigs[x];
      const reserve = IERC20Factory.connect(tokenAddress, proposer);
      const aToken = ATokenFactory.connect(aTokenAddress, proposer);
      const varDebtToken = VariableDebtTokenFactory.connect(variableDebtTokenAddress, proposer);
    }
  });
  it('Users should be able to claim incentives', async () => {
    // Initialize proxy for incentives controller
    const incentives = StakedTokenIncentivesControllerFactory.connect(incentivesProxy, proposer);
    const poolProvider = await ILendingPoolAddressesProviderFactory.connect(
      POOL_PROVIDER,
      proposer
    );
    const protocolDataProvider = await AaveProtocolDataProviderFactory.connect(
      await poolProvider.getAddress(
        '0x0100000000000000000000000000000000000000000000000000000000000000'
      ),
      proposer
    );

    const reserveConfigs = (await protocolDataProvider.getAllReservesTokens())
      .filter(({ symbol }) => RESERVES.includes(symbol))
      .sort(({ symbol: a }, { symbol: b }) => a.localeCompare(b));

    for (let x = 0; x < reserveConfigs.length; x++) {
      const { tokenAddress, symbol } = reserveConfigs[x];
      const { aTokenAddress, variableDebtTokenAddress } = await pool.getReserveData(
        reserveConfigs[x].tokenAddress
      );
      const reserve = IERC20Factory.connect(tokenAddress, proposer);

      // Amounts
      const depositAmount = parseUnits(spendList[symbol].deposit, spendList[symbol].decimals);

      // Deposit to LendingPool
      await (await reserve.connect(proposer).approve(pool.address, '0')).wait();
      await (await reserve.connect(proposer).approve(pool.address, depositAmount)).wait();
      const depositTx = await (
        await pool.connect(proposer).deposit(reserve.address, depositAmount, proposer.address, 0)
      ).wait();

      console.log("Gas used: ", depositTx.gasUsed.toString(), " for token ", symbol);

      await increaseTime(1296000);

      const priorBalance = await stkAave.balanceOf(proposer.address);
      const tx = await incentives
        .connect(proposer)
        .claimRewards([aTokenAddress, variableDebtTokenAddress], MAX_UINT_AMOUNT, proposer.address);
      await tx.wait();
      expect(tx).to.emit(incentives, 'RewardsClaimed');

      const afterBalance = await stkAave.balanceOf(proposer.address);
      expect(afterBalance).to.be.gt(priorBalance);
    }
  });
});
