// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.7.5;
pragma experimental ABIEncoderV2;

import {SafeERC20} from '@aave/aave-stake/contracts/lib/SafeERC20.sol';
import {SafeMath} from '../lib/SafeMath.sol';
import {DistributionTypes} from '../lib/DistributionTypes.sol';
import {VersionedInitializable} from '@aave/aave-stake/contracts/utils/VersionedInitializable.sol';
import {DistributionManager} from './DistributionManager.sol';
import {IERC20} from '@aave/aave-stake/contracts/interfaces/IERC20.sol';
import {IScaledBalanceToken} from '../interfaces/IScaledBalanceToken.sol';
import {IAaveIncentivesController} from '../interfaces/IAaveIncentivesController.sol';

/**
 * @title BaseIncentivesController
 * @notice Distributor contract for ERC20 rewards to the Aave protocol participants
 * @author Aave
 **/
contract BaseIncentivesController is
  IAaveIncentivesController,
  VersionedInitializable,
  DistributionManager
{
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  uint256 public constant REVISION = 7;

  address public override REWARD_TOKEN;
  address internal _rewardsVault;

  mapping(address => uint256) internal _old_var;

  // this mapping allows whitelisted addresses to claim on behalf of others
  // useful for contracts that hold tokens to be rewarded but don't have any native logic to claim Liquidity Mining rewards
  mapping(address => address) internal _authorizedClaimers;

  mapping(address => uint256) internal _usersUnclaimedRewards;

  uint256 public newRewardTokenAdjustmentAmount = 1000;
  bool public newRewardTokenAdjustmentMultiplier = false;

  event RewardsVaultUpdated(address indexed vault);
  event RewardTokenUpdated(address indexed token);

  modifier onlyAuthorizedClaimers(address claimer, address user) {
    require(_authorizedClaimers[user] == claimer, 'CLAIMER_UNAUTHORIZED');
    _;
  }

  constructor(IERC20 rewardToken, address emissionManager) DistributionManager(emissionManager) {
    REWARD_TOKEN = address(rewardToken);
  }

  /**
   * @dev Initialize AaveIncentivesController
   * @param rewardsVault rewards vault to pull funds
   **/
  function initialize(address rewardsVault) external initializer {
    _rewardsVault = rewardsVault;
  }

  function configureAssets(
    address[] calldata assets,
    uint256[] calldata emissionsPerSecond,
    uint256[] calldata assetDecimals
  ) external override onlyEmissionManager {
    require(assets.length == emissionsPerSecond.length, 'INVALID_CONFIGURATION');

    DistributionTypes.AssetConfigInput[] memory assetsConfig =
      new DistributionTypes.AssetConfigInput[](assets.length);

    for (uint256 i = 0; i < assets.length; i++) {
      assetsConfig[i].underlyingAsset = assets[i];
      assetsConfig[i].emissionPerSecond = uint104(emissionsPerSecond[i]);
      assetsConfig[i].decimals = uint8(assetDecimals[i]);

      require(assetsConfig[i].emissionPerSecond == emissionsPerSecond[i], 'INVALID_CONFIGURATION');

      assetsConfig[i].totalStaked = IScaledBalanceToken(assets[i]).scaledTotalSupply();
    }
    _configureAssets(assetsConfig);
  }

  function disableAssets(address[] calldata assets) external onlyEmissionManager {
    DistributionTypes.AssetConfigInput[] memory assetsConfig =
      new DistributionTypes.AssetConfigInput[](assets.length);
    for (uint256 i = 0; i < assets.length; i++) {
      assetsConfig[i].underlyingAsset = assets[i];
      assetsConfig[i].disabled = true;
    }
    _disableAssets(assetsConfig);
  }

  /// @inheritdoc IAaveIncentivesController
  function handleAction(
    address user,
    uint256 totalSupply,
    uint256 userBalance
  ) external override {
    uint256 accruedRewards = _updateUserAssetInternal(user, msg.sender, userBalance, totalSupply);
    if (accruedRewards != 0) {
      _usersUnclaimedRewards[user] = _usersUnclaimedRewards[user].add(accruedRewards);
      emit RewardsAccrued(user, accruedRewards);
    }
  }

  /// @inheritdoc IAaveIncentivesController
  function getRewardsBalance(address[] calldata assets, address user)
    external
    view
    override
    returns (uint256)
  {
    uint256 unclaimedRewards = _usersUnclaimedRewards[user];

    DistributionTypes.UserStakeInput[] memory userState =
      new DistributionTypes.UserStakeInput[](assets.length);
    for (uint256 i = 0; i < assets.length; i++) {
      userState[i].underlyingAsset = assets[i];
      (userState[i].stakedByUser, userState[i].totalStaked) = IScaledBalanceToken(assets[i])
        .getScaledUserBalanceAndSupply(user);
    }
    unclaimedRewards = unclaimedRewards.add(_getUnclaimedRewards(user, userState));
    // Divided by 1000 to adjust to new reward Token -> Requires maintaining the inflated reward distribution. 
    // Cleaner than forcing a bulkClaim for every user due to external smart contract integrations. 
    if (newRewardTokenAdjustmentMultiplier)
      {
      return unclaimedRewards.mul(newRewardTokenAdjustmentAmount); 
      }
    else
      {
      return unclaimedRewards.div(newRewardTokenAdjustmentAmount); 
      }
  }

  /// @inheritdoc IAaveIncentivesController
  function claimRewards(
    address[] calldata assets,
    uint256 amount,
    address to
  ) external override returns (uint256) {
    require(to != address(0), 'INVALID_TO_ADDRESS');
    return _claimRewards(assets, amount, msg.sender, msg.sender, to);
  }

  /// @inheritdoc IAaveIncentivesController
  function claimRewardsOnBehalf(
    address[] calldata assets,
    uint256 amount,
    address user,
    address to
  ) external override onlyAuthorizedClaimers(msg.sender, user) returns (uint256) {
    require(user != address(0), 'INVALID_USER_ADDRESS');
    require(to != address(0), 'INVALID_TO_ADDRESS');
    return _claimRewards(assets, amount, msg.sender, user, to);
  }

  /// @inheritdoc IAaveIncentivesController
  function bulkClaimRewardsOnBehalf(
    address[] calldata assets,
    uint256 amount,
    address user,
    address to
  ) external override onlyBulkClaimer returns (uint256) {
    require(user != address(0), 'INVALID_USER_ADDRESS');
    require(to != address(0), 'INVALID_TO_ADDRESS');
    return _claimRewards(assets, amount, msg.sender, user, to);
  }

  /// @inheritdoc IAaveIncentivesController
  function setClaimer(address user, address caller) external override onlyEmissionManager {
    _authorizedClaimers[user] = caller;
    emit ClaimerSet(user, caller);
  }

  /// @inheritdoc IAaveIncentivesController
  function getClaimer(address user) external view override returns (address) {
    return _authorizedClaimers[user];
  }

  /// @inheritdoc IAaveIncentivesController
  function getUserUnclaimedRewards(address _user) external view override returns (uint256) {
      if (newRewardTokenAdjustmentMultiplier)
      {
        return _usersUnclaimedRewards[_user].mul(newRewardTokenAdjustmentAmount); 
      }
    else
      {
        return _usersUnclaimedRewards[_user].div(newRewardTokenAdjustmentAmount); 
      }
  }

  /**
   * @dev returns the revision of the implementation contract
   */
  function getRevision() internal pure override returns (uint256) {
    return REVISION;
  }

  /**
   * @dev returns the current rewards vault contract
   * @return address
   */
  function getRewardsVault() external view returns (address) {
    return _rewardsVault;
  }

  /**
   * @dev update the rewards vault address, only allowed by the Rewards admin
   * @param rewardsVault The address of the rewards vault
   **/
  function setRewardsVault(address rewardsVault) external onlyEmissionManager {
    _rewardsVault = rewardsVault;
    emit RewardsVaultUpdated(rewardsVault);
  }

  /**
   * @dev update the rewards token address, only allowed by the EmissionManager
   * @param rewardToken The address of the new rewards token
   **/
  function setRewardToken(address rewardToken) external onlyEmissionManager {
    REWARD_TOKEN = rewardToken;
    emit RewardTokenUpdated(rewardToken);
  }

  /**
   * @dev update the RewardTokenAdjustmentMultiplier and the RewardTokenAdjustmentAmount, only allowed by the EmissionManager
   * @param RewardTokenAdjustmentMultiplier If the adjustment is a multiple or a division of the reference point.
   * @param RewardTokenAdjustmentAmount The amount of the multiple or a division relative to the reference point. (symm v1 pool)
   **/
  function setRewardTokenAdjustment( bool RewardTokenAdjustmentMultiplier, uint256 RewardTokenAdjustmentAmount) external onlyProxyAdmin {
    newRewardTokenAdjustmentMultiplier = RewardTokenAdjustmentMultiplier;
    newRewardTokenAdjustmentAmount = RewardTokenAdjustmentAmount;
  }

  /**
   * @dev Claims reward for an user on behalf, on all the assets of the lending pool, accumulating the pending rewards.
   * @param amount Amount of rewards to claim
   * @param user Address to check and claim rewards
   * @param to Address that will be receiving the rewards
   * @return Rewards claimed
   **/
  function _claimRewards(
    address[] calldata assets,
    uint256 amount,
    address claimer,
    address user,
    address to
  ) internal returns (uint256) {
    if (amount == 0) {
      return 0;
    }
    uint256 unclaimedRewards = _usersUnclaimedRewards[user];

    DistributionTypes.UserStakeInput[] memory userState =
      new DistributionTypes.UserStakeInput[](assets.length);
    for (uint256 i = 0; i < assets.length; i++) {
      userState[i].underlyingAsset = assets[i];
      (userState[i].stakedByUser, userState[i].totalStaked) = IScaledBalanceToken(assets[i])
        .getScaledUserBalanceAndSupply(user);
    }

    uint256 accruedRewards = _claimRewards(user, userState);
    if (accruedRewards != 0) {
      unclaimedRewards = unclaimedRewards.add(accruedRewards);
      emit RewardsAccrued(user, accruedRewards);
    }

    if (unclaimedRewards == 0) {
      return 0;
    }
    if (newRewardTokenAdjustmentMultiplier)
      {
      unclaimedRewards =  unclaimedRewards.mul(newRewardTokenAdjustmentAmount); 
      }
    else
      {
      unclaimedRewards =  unclaimedRewards.div(newRewardTokenAdjustmentAmount); 
      }

    uint256 amountToClaim = (amount > unclaimedRewards) ? unclaimedRewards : amount;
    _usersUnclaimedRewards[user] = unclaimedRewards - amountToClaim; // Safe due to the previous line

    IERC20(REWARD_TOKEN).safeTransferFrom(_rewardsVault, to, amountToClaim);
    emit RewardsClaimed(user, to, claimer, amountToClaim);

    return amountToClaim;
  }
}
